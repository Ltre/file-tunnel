# 隧道路由界面 SVG · 编号261106-3 第10项

本目录是需求原型，不代表已修改系统界面。覆盖当前可选的七个主题，每个主题两种状态，共14个独立SVG。统一画布900×700，文字为可编辑文本，图标为矢量路径，无外部资源依赖。

## 已加入隧道

- 顶部圆角品牌栏横向展开，标识居中；下方主体居中，依次为标题、说明、五位暗号输入框和扫描按钮。
- 五个输入框各60×64，间隔8，圆角12，使用中性底色与1px细描边。扫描按钮344×62，圆角16、1px细描边，图标在文字左侧。
- 扫描按钮下方显示“或进入已加入的隧道”，再下方是448×212的圆角组合框（圆角20、1px轻描边）。内部下拉框、进入按钮、创建按钮依次纵排，均宽424，左右对齐；下拉框有1px细描边，所选隧道文字相对整个选择框水平居中，右侧显示下拉箭头。

## 未加入任何隧道

- 品牌栏、标题、说明、暗号输入框和扫描按钮与已加入状态的位置、尺寸完全相同。
- 扫描按钮下方间隔44，直接放344×56的创建按钮，圆角16，与扫描按钮左右对齐。
- 不显示已加入隧道说明、下拉框、进入按钮及组合框，不为这一区域保留空位。

## 配色规则

- Lumen、Lusns的创建按钮保留上一轮已获认可的配色。
- 其余五个主题的创建按钮与“进入所选隧道”采用同一主色色系，按“色彩深度弱80%”处理：底色 = 20%进入按钮主色 + 80%所在主题面板底色，按sRGB通道混合并取整。主按钮若为渐变，则逐个色标按相同比例混合，保留渐变方向。
- 创建按钮使用柔和细边及清晰文字，不通过整个按钮的opacity来弱化文字。Orbit混入深色面板底色，其它主题混入各自浅色面板底色。
- header使用与主题协调的独立表面色／渐变，不直接使用第一或第二主色；文字和图标保证清晰。
- 描边随主题采用中性颜色；创建按钮采用淡色细边，进入按钮保留同色细边，不加厚重黑框。所有主题保持同样的组件尺寸、位置和字体规格。
- 进入按钮参考现有主题第一主色；创建按钮最新调整不再沿用第二主色。以上均为本批原型的配色约定，不修改系统主题变量。

| 主题 | 第一主色：进入 | 创建按钮淡底／细边 | header独立底色 | 两种状态 |
| --- | --- | --- | --- | --- |
| Lumen | #5347e8 → #6d60ef | #edf5f5 ／ #d4e5e6 | #ffffff → #f2f2ff | [已加入](Lumen/tunnel-route-add-scan.svg) · [未加入](Lumen/tunnel-route-add-scan-none.svg) |
| Orbit | #b8a7ff → #8dd5ef | #3a3a57 → #314354 ／ #40405f | #202537 → #20243a | [已加入](Orbit/tunnel-route-add-scan.svg) · [未加入](Orbit/tunnel-route-add-scan-none.svg) |
| Classic | #4258d6 | #d9def7 ／ #d2d7f5 | #2f405e → #52627f | [已加入](Classic/tunnel-route-add-scan.svg) · [未加入](Classic/tunnel-route-add-scan-none.svg) |
| Atelier | #2f6f73 | #d5e0dc ／ #cddad7 | #34515a → #60796f | [已加入](Atelier/tunnel-route-add-scan.svg) · [未加入](Atelier/tunnel-route-add-scan-none.svg) |
| Social | #1877f2 | #d1e4fc ／ #c8defc | #ffffff → #e9eef5 | [已加入](Social/tunnel-route-add-scan.svg) · [未加入](Social/tunnel-route-add-scan-none.svg) |
| Blamen | #3c29cf | #d2d1f5 ／ #cac9f3 | #e1e5f2 → #dce1ef | [已加入](Blamen/tunnel-route-add-scan.svg) · [未加入](Blamen/tunnel-route-add-scan-none.svg) |
| Lusns | #4133ca → #5545d8 → #7168df → #748be8 | #ecf3f9 ／ #d0e0ed | #e2efff → #f0f7ff | [已加入](Lusns/tunnel-route-add-scan.svg) · [未加入](Lusns/tunnel-route-add-scan-none.svg) |

SVG内使用稳定组件ID及data-color-role标注。几何尺寸用于明确原型的相对布局，不代表移动端必须使用900px固定宽度；窄屏按容器缩放或响应式适配，并保留上述排列关系。
