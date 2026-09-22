// miniprogram/utils/shared/types.ts

/** 测量状态枚举 */
export enum MeasureState {
  //export 让其他文件能使用这个定义
  IDLE = 0, // 空闲
  CALIBRATING = 1, // 正在计算零点基准
  READY = 2, // 基准已定，等待力量爆发触发
  MEASURING = 3, // 正在记录数据
  FINISHED = 4, // 测量结束
}
//例子：let status: MeasureState = MeasureState.IDLE;

/** 原始数据点结构体 */
export interface RawPoint {
  t: number; // 时间戳 (ms)  	TypeScript 没有区分整型和浮点型
  f: number; // 力量值 (kg)
  a: number; // 角度值 (deg)
}

/** 最终运算结果指标 */
export interface MeasurementResult {
  peakValue: number; // 力量峰值 (kg)
  rfdValue: number; // RFD (kg/s)
  activityValue: number; //运动时间 (s)
  durationValue: number; // 保持时间 (s)
  imuAngle: number; // IMU 角度变化
  imuPeak: number; //IMU的最大角度
  imuTime: number; // 运动时间
  percentageDiff: number; // 对比两次测量的百分比差异
  isMultiplePeaks: boolean; // 是否检测到二次发力
  points: RawPoint[]; // 存储这一轮的所有原始点，用于对比绘图
  label: string; // 自动生成的标签，如 "R-Lower-0210_1430"
  isForcedStopped: boolean; //是否超时强制停止
}

/** 保持时间计算结果 */
export interface HoldResult {
  duration: number; // 保持时间 (秒)
  isMultiplePeaks: boolean; // 是否检测到二次发力
}

/** 绘图配置参数包 */
export interface DrawConfig {
  width: number; // 画布宽度
  height: number; // 画布高度
  paddingL: number; //左侧留白
  paddingT: number; // 顶部留白
  paddingB: number; // 底部留白
  maxY: number; // Y轴最大量程
  offsetX: number; // 当前平移偏移量
  scaleX: number; // 当前缩放倍数
  startTime?: number; // 测量开始时间戳 (用于计算相对时间)
  maxDuration?: number; // 最大持续时间(ms)，用于统一两条曲线的时间轴
  color?: string; // 曲线颜色 (可选)
  isDash?: boolean; // 是否为虚线 (可选)
}
