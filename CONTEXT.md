# Swipe Pregeneration

A SillyTavern extension that prepares the next AI reply before the reader asks for it, so that swiping right is instant instead of a wait.

## Language

**备选回复 (Swipe)**:
One *finished* candidate text belonging to a single AI message, reachable by swiping left or right. A slot that is still being written is not one of these — it cannot be reached and is not counted.
_Avoid_: 候选、alternative、reroll

**预生成 (Pre-generation)**:
Producing a 备选回复 that nobody has asked for yet, so it is already there when the reader swipes.
_Avoid_: 预加载、缓存、prefetch

**排队 (Queue run)**:
One uninterrupted stretch of 预生成 aimed at a target count, which the reader can stop at any point.
_Avoid_: 批量、batch、任务

**遮挡层 (Mask)**:
The layer that keeps 预生成 invisible, so the reader goes on seeing the 备选回复 they chose while another one is being produced.
_Avoid_: 冻结、freeze、overlay、快照

**发送并排队 (Send and queue)**:
Sending a message with the intent that more than one 备选回复 comes back from it.
_Avoid_: 批量发送、多发
