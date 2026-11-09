# Specs

## Task-spec status

`docs/specs/tasks/*.md` 的 frontmatter 只使用以下状态：

| status | 含义 |
| --- | --- |
| `ready` | 规格已就绪，尚未交付；可以开始实现 |
| `implemented` | 已交付；保留作为设计记录，可被后续 task-spec 引用 |
| `deferred` | 未开始；正文必须写明启动条件 |
| `wontfix` | 否决并归档；保留文件，不删除 |

规则：

- 已交付的 task-spec 不删除。它们通过 `parent`、`depends-on`、`references` 被后续任务引用，删除会造成断链。
- 只有 `.scratch/` 下的临时工作项可以删除。
- 部分交付的 task-spec 保持 `ready`，并在正文写明剩余工作；不能因为代码路径已经存在就标成 `implemented`。
- `segmented-chapter-rollout-benchmark` 是当前例子：工具链已交付，但真实基线、盲评与放量裁决未完成，因此仍为 `ready`。
- `docs/plans/*.md` 在批次全部并入 `main` 后使用 `delivered`；`docs/specs/effect-first/SPEC.md` 作为持续约束保持 `draft`，确认冻结后再升级状态。
