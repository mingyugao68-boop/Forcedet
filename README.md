# ForceMeter 测力仪 · 微信小程序

基于微信小程序 + ESP32-S3 的肌肉力量（MMT）与关节活动度（ROM）测量系统。小程序通过 BLE 接收硬件设备（力传感器 + IMU）的实时数据流，完成力量测试、角度测量、趋势分析和云存储。

---

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 技术栈](#2-技术栈)
- [3. 目录结构](#3-目录结构)
- [4. 环境搭建](#4-环境搭建)
- [5. 项目运行](#5-项目运行)
- [6. 架构设计](#6-架构设计)
- [7. BLE 通信协议](#7-ble-通信协议)
- [8. 常见修改指南](#8-常见修改指南)
  - [8.1 修改 BLE 设备名称](#81-修改-ble-设备名称)
  - [8.2 修改测量阈值](#82-修改测量阈值)
  - [8.3 修改身体部位/动作选项](#83-修改身体部位动作选项)
  - [8.4 修改滤波参数](#84-修改滤波参数)
  - [8.5 修改 BLE 服务 UUID](#85-修改-ble-服务-uuid)
  - [8.6 修改 UI 文本和样式](#86-修改-ui-文本和样式)
  - [8.7 添加新页面](#87-添加新页面)
  - [8.8 修改曲线图样式](#88-修改曲线图样式)
  - [8.9 开启/关闭模拟模式](#89-开启关闭模拟模式)
  - [8.10 切换 AppID](#810-切换-appid)
  - [8.11 修改本地存储容量](#811-修改本地存储容量)
- [9. 数据流与测量流程](#9-数据流与测量流程)
- [10. 固件说明](#10-固件说明)
- [11. 常见问题](#11-常见问题)

---

## 1. 项目概览

本系统由三部分组成：

| 部分 | 说明 | 目录 |
|------|------|------|
| **微信小程序** | 用户交互界面、BLE 通信、数据处理、图表绘制、云存储 | `miniprogram/` |
| **ESP32-S3 固件** | 传感器驱动（NAU7802 + QMI8658A）、BLE 广播、数据帧发送 | `ESP32-S3-calib-v2/` |
| **辅助工具** | Python 版 BLE 接收器（PC 端调试用） | `slave_device/` |

测量模式：
- **MMT**：测量肌肉等长收缩的最大力量、发力率（RFD）、保持时间
- **ROM**：测量关节活动范围的角度变化

---

## 2. 技术栈

| 技术 | 说明 |
|------|------|
| **TypeScript** | 全部业务逻辑语言 |
| **WXML + WXSS** | 微信小程序模板与样式 |
| **Canvas 2D API** | 自定义实时曲线图绘制 |
| **@vant/weapp** ^1.11.7 | Vant UI 组件库（弹出层、选择器等） |
| **微信云开发** | 云数据库（测量记录）+ 云存储（CSV 文件） |
| **微信 BLE API** | 低功耗蓝牙通信 |
| **Skyline 渲染引擎** | 微信新一代渲染框架 |

---

## 3. 目录结构

```
force-meter/
├── miniprogram/                     # ★ 小程序主目录（上位机改的代码基本都在这里）
│   ├── app.json                     # 应用配置：页面注册、全局组件、窗口样式
│   ├── app.ts                       # 应用入口逻辑
│   ├── app.wxss                     # 全局样式
│   │
│   ├── pages/                       # 页面目录
│   │   ├── index/                   # ★ 主测量页面（整个 app 只有一个核心页面）
│   │   │   ├── index.wxml           #    页面模板：所有卡片、弹窗、按钮
│   │   │   ├── index.ts             #    页面逻辑：数据绑定、事件处理（~1800行）
│   │   │   ├── index.wxss           #    页面样式
│   │   │   └── index.json           #    页面配置
│   │   └── logs/                    # 调试日志页（简单展示启动时间戳）
│   │
│   ├── utils/                       # ★ 核心业务逻辑（最重要的目录）
│   │   ├── core/                    # 核心引擎
│   │   │   ├── BleManager.ts        #    BLE 蓝牙管理器（设备扫描/连接/数据接收）
│   │   │   └── MeasureEngine.ts     #    测量状态机（校准/触发/记录/停止）
│   │   ├── painters/                # Canvas 绑图器（8个，每个对应一张图表）
│   │   │   ├── BasePainter.ts       #    抽象基类（Canvas初始化/渲染循环）
│   │   │   ├── MMTPainter.ts        #    MMT 实时曲线（卡片视图）
│   │   │   ├── FullscreenMMTPainter.ts  # MMT 曲线（全屏）
│   │   │   ├── HistoryPainter.ts    #    MMT 历史趋势（卡片视图）
│   │   │   ├── FullscreenHistoryPainter.ts # MMT 趋势（全屏）
│   │   │   ├── ROMRealtimePainter.ts    # ROM 实时角度曲线
│   │   │   ├── FullscreenROMPainter.ts  # ROM 曲线（全屏）
│   │   │   ├── ROMHistoryPainter.ts     # ROM 历史趋势
│   │   │   └── FullscreenROMHistoryPainter.ts # ROM 趋势（全屏）
│   │   ├── shared/                  # 共享定义
│   │   │   ├── types.ts             #    核心类型定义（MeasureState, RawPoint等）
│   │   │   ├── Constants.ts         #    全局常量（BLE参数、测量阈值、滤波参数）
│   │   │   ├── MathUtils.ts         #    数学计算（峰值/RFD/保持时间）
│   │   │   ├── DrawUtils.ts         #    绘图工具（坐标轴/网格/曲线/触摸交互）
│   │   │   └── CommonUtils.ts       #    通用工具（时间格式化）
│   │   └── storage/                 # 数据存储
│   │       ├── BaseStorage.ts       #    本地存储封装（最多保存5条）
│   │       ├── CloudStorage.ts      #    云存储上传（CSV文件 + 云数据库）
│   │       ├── FeatureNoteManager.ts    # 特征数据管理（趋势对比/查询/统计）
│   │       ├── FileExporter.ts      #    CSV 文件导出
│   │       └── index.ts             #    统一导出
│   │
│   ├── ec-canvas/                   # ECharts 组件封装（当前未使用）
│   ├── jpg/                         # 静态图片资源
│   └── miniprogram_npm/             # npm 包编译产物（自动生成，不要手动修改）
│
├── ESP32-S3-calib-v2/               # ESP32-S3 固件（C++ / Arduino）
│   ├── ESP32-S3-calib-v2.ino        #    主固件文件
│   └── QMI8658.h                    #    IMU 驱动库
│
├── typings/                         # TypeScript 类型声明文件（微信 API 类型）
├── task_file/                       # 项目合同文档
├── project.config.json              # 微信开发者工具项目配置
├── tsconfig.json                    # TypeScript 编译配置
└── package.json                     # npm 依赖清单
```

---

## 4. 环境搭建

### 4.1 安装微信开发者工具

1. 下载地址：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
2. 选择 **稳定版（Stable Build）** 安装

### 4.2 安装 Node.js（用于 npm 包管理）

1. 下载地址：https://nodejs.org/ （推荐 LTS 版本，如 18.x 或 20.x）
2. 安装完成后打开终端，验证安装：
   ```bash
   node -v   # 应显示版本号
   npm -v    # 应显示版本号
   ```

### 4.3 安装项目依赖

在项目根目录下打开终端，运行：

```bash
npm install
```

### 4.4 构建 npm 包

在微信开发者工具中：
1. 点击菜单栏 **工具 → 构建 npm**
2. 等待构建完成，控制台提示 "构建 npm 完成"

> **说明**：`miniprogram/miniprogram_npm/` 目录是构建产物，如果此目录不存在或 npm 包有更新，需要重新执行此步骤。

---

## 5. 项目运行

### 5.1 导入项目

1. 打开 **微信开发者工具**
2. 点击 **+** 或 **导入项目**
3. 项目目录选择 `force-meter/`（根目录，不是 `miniprogram/` 子目录）
4. AppID 使用项目中的（`wx3492d0e2e7a58083`）或替换为自己的 AppID

### 5.2 云开发配置

项目使用了微信云开发（云数据库 + 云存储），需要：

1. 在微信开发者工具中点击 **云开发** 图标
2. 开通云开发环境
3. 在云开发控制台中：
   - 创建数据库集合：`measurements`、`featureNote`
   - 云存储中确认 `historyTest/` 文件夹存在

> 如果不需要云功能，可跳过此步。小程序在无网络时会展示"网络未连接"提示页，本地测量功能不受影响。

### 5.3 硬件连接

1. 给 ESP32-S3 设备上电
2. 确保设备 BLE 广播名称包含 `ESP32-forcedet`
3. 打开小程序 — 会自动搜索并连接设备
4. 若周围有多台设备，会弹出设备列表供选择

---

## 6. 架构设计

### 6.1 整体分层

```
┌─────────────────────────────────────────┐
│  页面层 (pages/index/)                    │
│  WXML 模板 + WXSS 样式 + Page 逻辑        │
├─────────────────────────────────────────┤
│  绘图层 (utils/painters/)                 │
│  8 个 Canvas Painter，负责各类曲线图渲染    │
├─────────────────────────────────────────┤
│  业务层                                   │
│  BleManager ←→ MeasureEngine             │
│  (BLE通信)     (测量状态机)                │
├─────────────────────────────────────────┤
│  数据层 (utils/storage/)                  │
│  本地存储 + 云存储 + CSV导出               │
├─────────────────────────────────────────┤
│  共享层 (utils/shared/)                   │
│  类型定义 + 常量 + 数学工具 + 绘图工具      │
└─────────────────────────────────────────┘
```

### 6.2 核心设计模式

- **单例模式**：`BleManager` 和 `MeasureEngine` 通过 `getInstance()` 获取全局唯一实例
- **回调/观察者模式**：模块间通过注册回调函数通信（如 `onDataPacket`、`onTick`、`onResultReady`）
- **状态机**：测量引擎实现 5 状态流转：`IDLE → CALIBRATING → READY → MEASURING → FINISHED`
- **模板方法模式**：`BasePainter` 提供 Canvas 初始化 + 渲染循环，子类实现 `drawFrame()`

### 6.3 数据流

```
ESP32 硬件 → BLE notify → BleManager（解析8字节帧）
    → MeasureEngine（滤波 → 校准 → 触发判断）
        → 回调 onTick → 页面更新显示 + Painter 绘制曲线
        → 回调 onResultReady → 页面展示结果
            → 用户点击保存 → Storage + Cloud + CSV导出
```

---

## 7. BLE 通信协议

ESP32 设备通过 BLE Notify 发送 **8 字节**数据帧，频率约 300Hz：

| 字节 | 内容 | 说明 |
|------|------|------|
| 0 | `0x46` ('F') | 帧头魔数，用于帧同步 |
| 1-4 | `int32` (小端序) | 力量值（原始 ADC 计数值） |
| 5-6 | `int16` (小端序) | IMU 角度值（单位：0.01°） |
| 7 | `uint8` | XOR 校验（字节 0-6 的异或结果） |

小程序端将原始力值除以 1000 转换为 kg，将角度值除以 100 转换为度。

**解析代码位于** `BleManager.ts` 中的 `parseFrame()` 方法。

---

## 8. 常见修改指南

这里是客户日后自己修改程序时最常遇到的场景。**每个修改项都标注了需要改的文件和具体位置。**

### 8.1 修改 BLE 设备名称

如果硬件设备广播名称变了：

**文件**：`miniprogram/utils/shared/Constants.ts` 第 9 行
```typescript
DEVICE_NAME: "ESP32-forcedet",  // 改为你的设备名称
```

### 8.2 修改测量阈值

**文件**：`miniprogram/utils/shared/Constants.ts` 第 14-20 行

| 常量 | 默认值 | 含义 |
|------|--------|------|
| `TRIGGER_THRESHOLD` | 5 | 力量超过此值(kg)自动开始记录 |
| `STOP_THRESHOLD` | 2 | 力量低于此值(kg)开始计时停止 |
| `STOP_DURATION_FRAME` | 15 | 低于停止阈值持续多少帧后停止 |
| `TIMEOUT_MS` | 10000 | 最大测量时长(ms)，超时强制停止 |

### 8.3 修改身体部位/动作选项

**文件**：`miniprogram/pages/index/index.ts` 约 57-70 行

身体部位列表：
```typescript
bodyPartOptions: [
  "颈椎", "胸椎", "腰椎", "肩关节", "肘关节",
  "腕关节", "髋关节", "膝关节", "踝关节",
],
```

动作选项（根据部位联动）在同一个文件的 `updateActionOptions()` 方法中定义。修改部位后记得同步修改对应的动作列表。

### 8.4 修改滤波参数

**文件**：`miniprogram/utils/shared/Constants.ts` 第 23-33 行

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `FORCE_ALPHA` | 0.15 | 力值滤波系数（越小越平滑，越大响应越快） |
| `ANGLE_ALPHA` | 0.3 | 角度滤波系数 |
| `ENABLE_FILTER` | true | 设为 false 关闭所有滤波 |

> 如果感觉数据显示太"迟钝"，增大 alpha；如果噪声太大，减小 alpha。

### 8.5 修改 BLE 服务 UUID

**文件**：`miniprogram/utils/shared/Constants.ts` 第 6-8 行
```typescript
SERVICE_UUID: "5e8d4b2a-7b01-4b77-a9fe-7bbd140bdf76",
CHAR_UUID:    "b4f36734-527d-4c6b-9cd9-5cfa1a260c60",
```

> ⚠️ 固件端也需要同步修改。固件代码在 `ESP32-S3-calib-v2/ESP32-S3-calib-v2.ino` 中根据 MAC 地址动态生成 UUID，如果改为固定 UUID，两端都要改。

### 8.6 修改 UI 文本和样式

- **页面文本**：`miniprogram/pages/index/index.wxml` — 搜索中文文本直接修改
- **页面样式**：`miniprogram/pages/index/index.wxss` — 修改颜色、字号、间距等
- **导航栏标题**：`miniprogram/app.json` 第 8 行 `navigationBarTitleText`

### 8.7 添加新页面

1. 在 `miniprogram/pages/` 下新建目录，创建 `.wxml` / `.ts` / `.wxss` / `.json` 四个文件
2. 在 `miniprogram/app.json` 的 `pages` 数组中注册路径：
   ```json
   "pages": [
     "pages/index/index",
     "pages/logs/logs",
     "pages/newpage/newpage"   // 新增
   ]
   ```
3. 重新编译即可

### 8.8 修改曲线图样式

所有曲线图绘制逻辑在 `miniprogram/utils/painters/` 目录下：
- **线条颜色、虚实**：在对应 Painter 的 `drawFrame()` 方法中
- **坐标轴、网格、字体**：在 `miniprogram/utils/shared/DrawUtils.ts` 中
- **Y 轴量程**：各 Painter 中调用 `DrawUtils.calcNiceMaxY()` 时传入参数调整

### 8.9 开启/关闭模拟模式

**文件**：`miniprogram/utils/shared/Constants.ts` 第 11 行
```typescript
MOCK_MODE: true,  // 改为 true 可在无硬件时用模拟数据调试
```

模拟数据生成逻辑在 `BleManager.ts` 的 `startMockDataStream()` 方法中。

### 8.10 切换 AppID

**文件**：`project.config.json` 第 55 行
```json
"appid": "wx3492d0e2e7a58083"
```
改为你自己的小程序 AppID。同时需要在微信开发者工具中重新登录授权。

### 8.11 修改本地存储容量

**文件**：`miniprogram/utils/storage/BaseStorage.ts`
```typescript
private maxItems: number = 5;  // 修改此值改变本地保存的最大记录数
```

---

## 9. 数据流与测量流程

一次完整测量的生命周期：

```
1. 用户点击「开始测量」
       ↓
2. MeasureEngine 进入 CALIBRATING 状态
   采集 60 个采样点计算零点基准（约 200ms）
       ↓
3. 进入 READY 状态，等待力量触发
   当力值 > 5kg → 自动进入 MEASURING
       ↓
4. MEASURING 状态持续记录 RawPoint[]
   同时 Painter 实时绘制力值/角度曲线
       ↓
5. 停止条件（满足任一）：
   - 力值 < 2kg 持续 15 帧（约 50ms）→ 自然结束
   - 超过 10 秒 → 超时强制结束
       ↓
6. 进入 FINISHED 状态
   计算峰值 / RFD / 保持时间 / 二次发力检测
       ↓
7. 用户点击「保存数据」
   → 本地 Storage（MMT + ROM）
   → 云数据库（featureNote集合）
   → 云存储（CSV文件上传）
   → 趋势图自动刷新
```

---

## 10. 固件说明

固件文件位于 `ESP32-S3-calib-v2/ESP32-S3-calib-v2.ino`（约 2000 行），基于 Arduino 框架编写。

**硬件平台**：ESP32-S3
**传感器**：
- NAU7802 — 24位 ADC，连接桥式称重传感器（load cell），320 SPS
- QMI8658A — 6轴 IMU（加速度计 + 陀螺仪），约 200Hz

**主要功能模块**：
- 传感器初始化与校准（ADC 零点和内部校准、IMU 零偏校准）
- 传感器融合（互补滤波器：陀螺仪积分 + 加速度计校正 → 角度估计）
- BLE GATT 服务（动态 UUID v5 生成，每个设备唯一）
- WiFi AP + WebSocket（可选，用于浏览器端实时监控）
- 串口命令接口（`CAL`, `IMU_ZERO`, `STATUS`）

**如需修改固件**：
1. 安装 Arduino IDE 并配置 ESP32-S3 开发板支持
2. 安装所需库：NAU7802、QMI8658（代码已包含头文件）
3. 用 USB 连接 ESP32-S3，选择对应端口和开发板型号
4. 编译上传

---

## 11. 常见问题

### Q1：编译报错 "找不到模块 @vant/weapp"
**答**：在微信开发者工具中执行 **工具 → 构建 npm**。

### Q2：真机搜索不到蓝牙设备
**答**：
1. 确认手机蓝牙已开启
2. 确认微信有蓝牙权限（手机设置 → 微信 → 蓝牙）
3. 确认设备已上电且在广播范围内
4. iOS 设备对 BLE 更严格，可尝试重启微信

### Q3：图表曲线不显示
**答**：检查 Canvas 节点是否正确初始化。确认 `miniprogram/pages/index/index.wxml` 中 `<canvas>` 标签的 `type="2d"` 属性存在。

### Q4：云存储上传失败
**答**：
1. 确认已在微信开发者工具中开通云开发
2. 确认云开发环境 ID 已配置
3. 确认数据库集合 `measurements` 和 `featureNote` 已创建
4. 检查手机网络连接

### Q5：如何调试 TypeScript 代码
**答**：
1. 微信开发者工具支持 TypeScript 源码调试
2. 在 `index.ts` 中设置断点
3. 使用 `console.log()` 输出变量到控制台
4. 模拟器 + 真机调试均可使用

### Q6：想修改 App 名称（导航栏标题）
**答**：修改 `miniprogram/app.json` 第 8 行的 `navigationBarTitleText` 字段。

