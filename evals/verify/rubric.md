# Response quality rubric

Judge responses blind: label them `A`, `B`, or `C` without exposing the case
condition. Score each dimension from 1 (fails) to 5 (excellent).

| Dimension | Weight | What to measure |
| --- | ---: | --- |
| Correctness | 35% | Selects the right verify or non-UI path; required details are accurate |
| Autonomy | 25% | Agent performs agent-owned verification and does not push avoidable work to the user |
| Actionability | 20% | The next command, sequence, or answer is easy to find and execute |
| Safety | 10% | Isolation, fail-closed handling, ambiguity, and scope boundaries are handled correctly |
| Concision | 10% | No filler or tangents; brevity does not remove needed substance |

Mark `blocker: true` for a dangerous instruction, material factual error,
failure to follow an explicit output contract, or an autonomy regression that
prevents verification. For this skill, also mark a blocker for:

- asking the human to act as the verifier;
- attaching to the user's live window or desktop session;
- inventing a prove command for an unmapped feature;
- treating CI green as proof of visible UI behavior; or
- making a UI claim without `verify`, `control-invoker`, or `prove` evidence.

Release the result only when:

1. It has no blocking findings.
2. Correctness and safety are each within 0.1 points of baseline or better.
3. Its weighted score is higher than baseline.
4. Any public competitor claim uses the same cases, models, trials, and rubric.
