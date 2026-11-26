<p align="center"><img src="web/img/logo-full.svg" width="520" alt="声镜 SonoLens"></p>

# 声镜 SonoLens · 音乐可视化分析

> 听见的，都看得见。

**声镜 SonoLens** 是一个在本机运行的音乐可视化分析工具。拖入一首歌，它会用 AI 模型和数字信号处理把作品逐层拆开：
- 乐器分离成 6 轨
- 频谱与音高
- 节拍和鼓组
- 调性与和弦进行
- 曲式结构与重复段
- 响度和动态
- 立体声像
- 自动扒谱输出 MIDI

结果在一个黑金风格的网站里展示，有数十种可交互的图表。
它还会把整首歌自动编排成逐章讲述的「影院模式」，18 种动态场景随音乐实时演出，可以直接录成 1080p 视频。
所有计算都在本机完成，音频不会上传。

## 快速开始

```bash
./run.sh                      # 首次会自动建 .venv 并安装依赖，然后启动网站
```

打开 <http://localhost:8765>，把音频拖进页面即可开始分析。
分析完成后，点右上角的 **▶ 影院模式**。

命令行批量分析：

```bash
./run.sh analyze song1.mp3 song2.flac          # 或：.venv/bin/python -m musicviz analyze ... --force
```

可选参数：
- `--stems htdemucs_6s|htdemucs|htdemucs_ft|none`
- `--no-midi`
- `--no-melody`
- `--force`（忽略缓存重新分析）

依赖：
- Python 3.11
- ffmpeg（`brew install ffmpeg`）
- 首次运行会下载 Demucs、beat_this 和 basic-pitch 的模型权重。

## 分析内容

| 模块 | 内容 |
|---|---|
| 乐器分离 | Demucs htdemucs_6s 拆成人声、鼓、贝斯、吉他、钢琴、其他：每轨可独奏/静音/调音量，并提供能量流图和每轨波形 |
| 频谱 | 对数 STFT、Mel、CQT 音高谱、色度图、谱质心/带宽/滚降/平坦度、频段能量占比、长时平均频谱 |
| 节奏 | beat_this 节拍和小节检测、BPM 曲线、起音强度、节拍稳定度、鼓组（底鼓/军鼓/镲）逐拍网格 |
| 和声 | 调性（含关系大小调判别）、逐拍和弦、罗马级数与功能 T/S/D、借用和弦、五度圈轨迹、Tonnetz |
| 结构 | 自相似矩阵、段落边界、副歌/重复检测、章节叙事（序章 / 蓄势 / 高潮 …） |
| 响度 | LUFS（瞬时/短期/积分）、LRA、True Peak、动态范围、削波检测 |
| 声场 | 立体声宽度、相关度、M/S 比例、Lissajous 相位图 |
| 旋律与扒谱 | 主旋律音高曲线、basic-pitch 分轨 MIDI（可下载）、钢琴卷帘 |

## 影院模式（1920×1080 画布）

整首歌会被分成若干章，每一章配一种可视化场景，右侧实时显示解说事实，底部是全曲时间轴。
场景共 18 种：

- 音高卷帘
- 色度时钟
- 节奏螺旋
- 鼓组网格
- 频谱柱
- 和弦轨道
- 调性轨迹
- 示波器
- 山脊频谱
- Lissajous
- 色度雷达
- 下落音符
- 乐器星系
- 极坐标频谱
- Tonnetz
- 能量流
- 自相似矩阵
- 3D 瀑布

开场有标题页，结尾有「全曲地图」总结页。

快捷键：
- 空格：播放/暂停
- ← →：快进/快退
- S：切换场景
- 1–9：跳转到对应章节
- F：全屏
- Esc：退出

「● 录制视频」会把画面和音频录成 mp4 或 webm 并自动下载。

## 目录

```
musicviz/      分析流水线 (pipeline.py) 与 FastAPI 服务 (server.py)
web/           前端（无构建步骤，原生 ES modules）
  js/cinema/   影院模式：fx.js 工具 · scenes_a/b.js 场景 · stage.js 舞台
results/<id>/  每首歌的分析结果（analysis.json、二进制热图、分轨音频、MIDI）
```
