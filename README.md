## 简介
主要配合EchoGraph（[https://github.com/duiywegkl/EchoGraph.git](https://github.com/duiywegkl/EchoGraph)）进行前后台联动

## 设置与入口

- 在 SillyTavern 的“扩展程序”页面展开“EchoGraph”，可启用或停用插件、设置后端地址、测试连接、查看连接状态，以及切换通知和调试模式。
- 魔棒扩展菜单中的“EchoGraph 滑动窗口”仍可打开 EchoGraph 面板；扩展程序页面中的“打开 EchoGraph 面板”按钮也可打开。

## SillyTavern 1.18.0 兼容范围

- 提示词增强使用 `CHAT_COMPLETION_PROMPT_READY`，适用于 Chat Completion API。插件跳过 dry run 和 quiet/background generation，并防止同一提示词重复注入。Text Completion API 不会发出该事件，因此目前不会获得提示词增强；SillyTavern 的 `setExtensionPrompt` 和 `GENERATE_AFTER_COMBINE_PROMPTS` 可用于覆盖 Text Completion，但需要单独适配文本提示词格式和异步增强时机。
- 群聊的 `tavern_chat_id` 使用 group ID 和 chat ID，不依赖聊天数组对象。当前后端会话初始化仍依赖单一角色卡，因此群聊的完整记忆处理尚未支持。
