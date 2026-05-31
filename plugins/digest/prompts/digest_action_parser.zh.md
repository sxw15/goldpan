上下文：
- 可用预设：{{presetNames}}
- 用户消息：{{userInput}}

输出 JSON 对象，必须包含 "kind" 字段与相应字段。合法取值：
- {"kind":"subscribe","presetName":"<名字>","pushTime":"HH:MM"}
- {"kind":"unsubscribe"[,"presetName":"<名字>"]}
- {"kind":"list"}
- {"kind":"pause"[,"presetName":"<名字>"]}
- {"kind":"resume"[,"presetName":"<名字>"]}
- {"kind":"set_push_time"[,"presetName":"<名字>"],"pushTime":"HH:MM"}

规则：
- presetName 必须来自上述列表
- pushTime 必须是 24 小时 HH:MM
- 用户请求模糊时，选最接近的或回退到 "list"

只输出 JSON，不要有其它文字。
