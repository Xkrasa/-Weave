import type { CharacterRegistry } from './types.ts'
import type { TimelineCheck, TimelineEvent } from './stage-types.ts'

const SEASON_BY_MONTH: Record<number, string> = {
  3: '春', 4: '春', 5: '春',
  6: '夏', 7: '夏', 8: '夏',
  9: '秋', 10: '秋', 11: '秋',
  12: '冬', 1: '冬', 2: '冬',
}

export function validateTimeline(events: TimelineEvent[], registry: CharacterRegistry): TimelineCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const byId = new Map<string, TimelineEvent>()
  const people = new Map(registry.characters.map(character => [character.name, character]))
  const prepared: Array<TimelineEvent & { date?: Date; offset?: number }> = []

  for (const event of events) {
    if (!event.eventId) {
      errors.push('存在缺少 eventId 的时间线事件')
      continue
    }
    if (byId.has(event.eventId)) {
      errors.push(`时间线事件 ID 重复：${event.eventId}`)
      continue
    }
    byId.set(event.eventId, event)
    if (!event.summary?.trim()) errors.push(`事件 ${event.eventId} 缺少 summary`)
    if (!Number.isSafeInteger(event.chapter) || event.chapter <= 0) {
      errors.push(`事件 ${event.eventId} 的 chapter 非法`)
    }
    const date = event.storyDate ? parseDate(event.storyDate) : undefined
    if (event.storyDate && !date) errors.push(`事件 ${event.eventId} 的日期无法解析：${event.storyDate}`)
    if (event.dayOffset !== undefined && (!Number.isSafeInteger(event.dayOffset) || event.dayOffset < 0)) {
      errors.push(`事件 ${event.eventId} 的 dayOffset 必须是非负整数`)
    }
    if (event.durationDays !== undefined && (!Number.isSafeInteger(event.durationDays) || event.durationDays < 0)) {
      errors.push(`事件 ${event.eventId} 的 durationDays 必须是非负整数`)
    }
    if (event.dayOffset === undefined && !date) {
      warnings.push(`事件 ${event.eventId} 没有时间锚点`)
    }
    if (event.season && date) {
      const expected = SEASON_BY_MONTH[date.getUTCMonth() + 1]
      if (expected && event.season !== expected) {
        warnings.push(`事件 ${event.eventId} 标注季节「${event.season}」，但日期属于${expected}`)
      }
    }
    for (const participant of event.participants ?? []) {
      if (registry.characters.length > 0 && !people.has(participant)) {
        errors.push(`事件 ${event.eventId} 引用了不存在的人物：${participant}`)
      }
    }
    for (const [name, age] of Object.entries(event.ages ?? {})) {
      if (!Number.isSafeInteger(age) || age < 0) {
        errors.push(`事件 ${event.eventId} 中人物 ${name} 的年龄非法`)
        continue
      }
      const person = people.get(name)
      if (!person) {
        errors.push(`事件 ${event.eventId} 的 ages 引用了不存在的人物：${name}`)
        continue
      }
      if (person.birthDate && date) {
        const birth = parseDate(person.birthDate)
        if (birth) {
          const expected = date.getUTCFullYear() - birth.getUTCFullYear() - (
            date.getUTCMonth() < birth.getUTCMonth()
            || (date.getUTCMonth() === birth.getUTCMonth() && date.getUTCDate() < birth.getUTCDate())
              ? 1 : 0
          )
          if (Math.abs(expected - age) > 1) {
            errors.push(`事件 ${event.eventId}：人物 ${name} 标注 ${age} 岁，按生日推算应为 ${expected} 岁（容差 ±1）`)
          }
        }
      }
    }
    prepared.push({ ...event, date, offset: event.dayOffset })
  }

  for (const event of prepared) {
    for (const cause of event.causedBy ?? []) {
      if (cause === event.eventId) {
        errors.push(`事件 ${event.eventId} 不能以自己为原因`)
        continue
      }
      const causeEvent = byId.get(cause)
      if (!causeEvent) {
        errors.push(`事件 ${event.eventId} 的 causedBy 引用了不存在的事件：${cause}`)
        continue
      }
      if (
        event.type !== 'flashback'
        && causeEvent.chapter > event.chapter
      ) {
        errors.push(`事件 ${event.eventId}（第${event.chapter}章）引用了后续章节的原因事件 ${cause}`)
      }
    }
  }

  const ordered = [...prepared].sort((a, b) => a.chapter - b.chapter || (a.offset ?? 0) - (b.offset ?? 0))
  let previous: (TimelineEvent & { date?: Date; offset?: number }) | null = null
  for (const event of ordered) {
    if (event.type === 'flashback') continue
    if (previous && previous.offset !== undefined && event.offset !== undefined) {
      if (event.offset < previous.offset) {
        errors.push(`事件 ${event.eventId} 的时间早于前一事件 ${previous.eventId}`)
      } else {
        const previousEnd = previous.offset + (previous.durationDays ?? 0)
        if (event.offset < previousEnd && !(event.type === 'parallel' || previous.type === 'parallel')) {
          errors.push(`事件 ${event.eventId} 与前一事件 ${previous.eventId} 的时间区间重叠`)
        }
        if (event.offset - previousEnd > 365) {
          warnings.push(`事件 ${event.eventId} 与前一事件间隔超过一年，建议确认是否漏写时间过渡`)
        }
      }
    }
    previous = event
  }

  return { events: ordered, errors, warnings, passed: errors.length === 0 }
}

function parseDate(value: string): Date | undefined {
  const normalized = value.trim().replace(/[/.]/g, '-')
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return undefined
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) return undefined
  return date
}
