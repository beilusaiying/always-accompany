# P1: A Pre-Cognitive Divergence Engine — Technical Paper

P1 自驱动发散召回系统技术论文 / Technical paper of the P1 Self-Driven Divergent Recall system.

P1 is the cognitive front-end of always-accompany: before the main LLM generates a reply, P1 completes a multi-dimensional semantic divergence over the user input — with the current production route (Route 1) running fully LLM-free — and injects the resulting direction words into the LLM context.

## 目录 / Contents

| # | 中文 | English |
|---|------|---------|
| 1 | [引言与相关工作](zh/01_引言与相关工作.md) | [Introduction & Related Work](en/01_introduction_related_work.md) |
| 2 | [系统架构](zh/02_系统架构.md) | [System Architecture](en/02_system_architecture.md) |
| 3 | [核心算法：召回与发散](zh/03_核心算法_召回与发散.md) | [Core Algorithms: Recall & Divergence](en/03_core_algorithms_recall_divergence.md) |
| 4 | [BLQ 打分与输出系统](zh/04_BLQ打分与输出系统.md) | [BLQ Scoring & Output System](en/04_blq_scoring_output.md) |
| 5 | [词库体系](zh/05_词库体系.md) | [Vocabulary System](en/05_vocabulary_system.md) |
| 6 | [实验与评估](zh/06_实验与评估.md) | [Experiments & Evaluation](en/06_experiments_evaluation.md) |
| 7 | [结论与附录](zh/07_结论与附录.md) | [Conclusion & Appendices](en/07_conclusion_appendices.md) |

## 阅读说明 / Notes

- 论文区分**设计层**与**实现层**：凡当前实现与设计意图存在已知偏差处，均以"实现偏差"显式标注。/ The paper distinguishes the design layer from the implementation layer; every known deviation of the current implementation from the design intent is explicitly annotated.
- 所有评估分数已经过 -0.5 系统性校准（评分器偏差校准），详见第六章 7.1.2 节。/ All evaluation scores are reported after a uniform -0.5 calibration for grader bias; see Section 7.1.2.

## 许可 / License

- 代码 / Code: AGPL-3.0（见仓库根目录 [LICENSE](../../LICENSE)）
- 论文与词库 / Paper & vocabulary data: CC BY-NC-SA 4.0
- 商业使用或衍生研究请先与作者联系商议。/ Commercial use or derivative research requires prior consultation with the author.
