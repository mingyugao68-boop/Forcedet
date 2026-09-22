// miniprogram/utils/core/MeasureEngine.ts

import { RawPoint, MeasureState, MeasurementResult } from "../shared/types";
import { BleManager } from "./BleManager";
import { MathUtils } from "../shared/MathUtils";
import { MEASURE_CONFIG, FILTER_CONFIG } from "../shared/Constants";
/** 测量引擎：负责状态机切换、数据缓存、算法运算 */
export class MeasureEngine {
  private static instance: MeasureEngine | null = null; //私有静态成员，单例模式实现
  //缓存测试过程中所有点，用于计算指标：
  private rawBuffer: RawPoint[] = []; // 数据缓冲区
  // UI 绘图专用缓冲池，用于实时曲线
  private displayBuffer: RawPoint[] = [];

  private state: MeasureState = MeasureState.IDLE;
  private ble = BleManager.getInstance();
  private timeoutTimer: number | null = null; //超时计时器，测试超时自动停止
  private measureStartTime: number = 0; // 记录本次录制的起始时间
  // --- 测量相关参数 ---
  private baseline = 0; // 零点基准
  private baselineAngle = 0; //角度基准
  private lowForceCounter = 0; // 用于记录力量低于阈值的连续帧数

  // --- 滤波器状态 ---
  private filteredForce: number = 0; // 滤波后的力值
  private filteredAngle: number = 0; // 滤波后的角度
  private isFilterInitialized: boolean = false; // 滤波器是否已初始化

  //两次loop逻辑
  private firstLoopResult: MeasurementResult | null = null; // 暂存第一轮结果
  private firstLoopStartTime: number = 0; // 第一轮测量的起始时间
  private currentLoopIndex: number = 1; // 记录当前是第几轮

  //用于保存数据的测量选项：（左-下肢）
  private currentLabel: string = "";

  // 公开的事件回调（信号）----------------------------------------------------------
  public onResultReady: ((res: MeasurementResult) => void) | null = null;
  public onTick: ((force: number, angle: number) => void) | null = null;
  public onStateChanged: ((state: MeasureState) => void) | null = null;

  //私有构造函数----------------------------------------------------------
  private constructor() {
    //订阅事件
    this.ble.onDataPacket = (f, a) => this._processIncomingData(f, a);

    // 监听蓝牙意外断开事件，只重置状态，保留测量数据
    this.ble.onUnexpectedDisconnect = () => {
      console.log("MeasureEngine: 收到蓝牙意外断开信号，重置状态（保留数据）");
      this._resetStateOnly();
    };
  }
  //获取单例实例
  static getInstance(): MeasureEngine {
    if (!MeasureEngine.instance) {
      MeasureEngine.instance = new MeasureEngine();
    }
    return MeasureEngine.instance;
  }

  /** 处理每一帧输入的原始数据 (300Hz) */
  private _processIncomingData(f: number, a: number) {
    // 应用滤波算法
    const { filteredF, filteredA } = this._applyFilter(f, a);

    // 1. 转发 Tick 信号给 UI 刷新实时数值，在page层以100hz进行刷新
    this.onTick?.(filteredF, filteredA);

    switch (this.state) {
      case MeasureState.CALIBRATING:
        this._handleCalibration(filteredF, filteredA);
        break;

      case MeasureState.READY:
        let filteredFCalib = filteredF - this.baseline; //将得到的力值减去基准值，去除系统偏差
        let filteredACalib = filteredA - this.baselineAngle;
        // 自动开始逻辑：当前力 > 基准 + 5N
        if (filteredFCalib > MEASURE_CONFIG.TRIGGER_THRESHOLD) {
          //if (filteredF > this.baseline + MEASURE_CONFIG.TRIGGER_THRESHOLD) {
          this._handleReady();
          this._updateScrollingBuffer(filteredFCalib, filteredACalib);
        }
        break;

      case MeasureState.MEASURING:
        filteredFCalib = filteredF - this.baseline; //将得到的力值减去基准值，去除系统偏差
        filteredACalib = filteredA - this.baselineAngle;
        this._handleMeasuring(filteredFCalib, filteredACalib);
        break;
    }
  }

  /**
   * 一阶低通滤波器 (Exponential Moving Average)
   * 公式: y[n] = α × x[n] + (1 - α) × y[n-1]
   */
  private _applyFilter(
    rawForce: number,
    rawAngle: number,
  ): { filteredF: number; filteredA: number } {
    // 如果滤波功能关闭，直接返回原始值
    if (!FILTER_CONFIG.ENABLE_FILTER) {
      return { filteredF: rawForce, filteredA: rawAngle };
    }

    // 首次调用时，用原始值初始化滤波器状态
    if (!this.isFilterInitialized) {
      this.filteredForce = rawForce;
      this.filteredAngle = rawAngle;
      this.isFilterInitialized = true;
      return { filteredF: rawForce, filteredA: rawAngle };
    }

    // 应用一阶低通滤波
    const alpha_f = FILTER_CONFIG.FORCE_ALPHA;
    const alpha_a = FILTER_CONFIG.ANGLE_ALPHA;

    this.filteredForce =
      alpha_f * rawForce + (1 - alpha_f) * this.filteredForce;
    this.filteredAngle =
      alpha_a * rawAngle + (1 - alpha_a) * this.filteredAngle;

    return { filteredF: this.filteredForce, filteredA: this.filteredAngle };
  }

  private _updateScrollingBuffer(f: number, a: number) {
    this.displayBuffer.push({ t: Date.now(), f, a }); //ready时曲线是滚动的：
    if (this.displayBuffer.length > 200) {
      this.displayBuffer.shift(); // 超过200个点就开始滚动
    }
  }

  private _handleCalibration(f: number, a: number) {
    this.rawBuffer.push({ t: Date.now(), f, a });

    // 200ms 约 60 个点 (@300Hz)
    if (this.rawBuffer.length >= 60) {
      const sum = this.rawBuffer.reduce((acc, p) => acc + p.f, 0);
      this.baseline = sum / this.rawBuffer.length;

      console.log(
        "力值基准校准完成，后续测量值均减去偏差:",
        this.baseline.toFixed(2),
        "kg",
      );
      //校准角度
      const sumAngle = this.rawBuffer.reduce((acc, p) => acc + p.a, 0);
      this.baselineAngle = sumAngle / this.rawBuffer.length;
      console.log(
        "角度基准校准完成，后续测量值均减去偏差:",
        this.baselineAngle.toFixed(2),
        "°",
      );
      this.rawBuffer = []; // 清空，准备正式测量
      this._updateState(MeasureState.READY);
    }
  }

  private _handleReady() {
    console.log("检测到力量爆发，自动开始测量！");
    //启动定时器，超时未测量结束时，强制停止
    this.timeoutTimer = setTimeout(() => {
      console.warn("测量超过 60s 未停止，触发强制停止保护");
      this.stopMeasure(true); // 传入 true 表示是“强制停止”
    }, MEASURE_CONFIG.TIMEOUT_MS);

    this.rawBuffer = [];
    this.lowForceCounter = 0;
    this.measureStartTime = Date.now(); //记录这一刻的时间

    // 如果是第一轮测量，保存起始时间
    if (this.currentLoopIndex === 1) {
      this.firstLoopStartTime = this.measureStartTime;
    }

    this._updateState(MeasureState.MEASURING);
  }

  private _handleMeasuring(f: number, a: number) {
    if (this.rawBuffer.length > 180000) {
      console.warn("this.rawBuffer.length", this.rawBuffer.length);
      return; //totest
    }
    this.displayBuffer.push({ t: Date.now(), f, a }); // 从0开始，不滚动，只增加
    //缓存数据
    this.rawBuffer.push({ t: Date.now(), f, a });

    // 自动结束逻辑：PDF 要求持续 50ms 低于阈值
    if (f < MEASURE_CONFIG.STOP_THRESHOLD) {
      this.lowForceCounter++;
      if (this.lowForceCounter >= MEASURE_CONFIG.STOP_DURATION_FRAME) {
        console.log("力量回落，自动结束测量");
        this.stopMeasure();
      }
    } else {
      this.lowForceCounter = 0; // 只要力量一回来，计数器清零
    }
  }

  private _updateState(s: MeasureState) {
    this.state = s;
    this.onStateChanged?.(s);
  }

  //重置逻辑，用于第一次测量和第二次测量的开始
  private _initiateMeasurement(loopIndex: number, logMsg: string) {
    console.log(`${logMsg} 第 ${loopIndex} 轮`);

    // 统一复位状态
    this.currentLoopIndex = loopIndex;
    this.rawBuffer = [];
    this.displayBuffer = [];
    this.baseline = 0;
    this.baselineAngle = 0;
    this.lowForceCounter = 0; // 重置消抖计数器
    if (loopIndex === 1) {
      this.firstLoopResult = null; //清除第一轮的历史备份，这样灰色线就消失了
    }
    // 统一进入校准状态
    this._updateState(MeasureState.CALIBRATING);
  }

  /** 开始测量 */
  startMeasure(label: string = "Unknown") {
    this._initiateMeasurement(1, "---流程启动：正在校准基准...");
    this.currentLabel = label;
    // 触发三阶段模拟数据
    this.ble.triggerThreePhaseMockData();
  }

  /** 切换到第二轮 */
  prepareSecondLoop() {
    this._initiateMeasurement(2, "---启动对比测量流程...");
  }

  /** 开始第二轮测量（保留第一轮数据用于对比显示） */
  startSecondMeasure(label: string = "Unknown") {
    this._initiateMeasurement(2, "---启动第二轮测量流程...");
    this.currentLabel = label;
    // 触发三阶段模拟数据
    this.ble.triggerThreePhaseMockData();
  }

  /** 停止测量并触发计算 */
  stopMeasure(isForced: boolean = false) {
    // 允许在 CALIBRATING、READY、MEASURING 状态下停止
    if (
      this.state === MeasureState.IDLE ||
      this.state === MeasureState.FINISHED
    )
      return;
    //清理定时器
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null; // 释放指针
      console.log("计时器已清理");
    }

    // 如果是在 CALIBRATING 或 READY 状态下停止，只重置状态，不生成结果
    if (
      this.state === MeasureState.CALIBRATING ||
      this.state === MeasureState.READY
    ) {
      console.log(
        "在",
        this.state === MeasureState.CALIBRATING ? "校准" : "准备",
        "阶段停止，重置状态",
      );
      this.rawBuffer = [];
      this.displayBuffer = [];
      this.baseline = 0;
      this.baselineAngle = 0;
      this._updateState(MeasureState.IDLE);
      return;
    }

    // 以下为 MEASURING 状态下的正常停止逻辑
    this._updateState(MeasureState.FINISHED);
    const currentResult = MathUtils.calculateAllMetrics(this.rawBuffer);
    currentResult.points = [...this.rawBuffer]; // 保存当前原始路径
    // 将标签注入结果对象
    currentResult.label = this.currentLabel;
    console.log("生成标签:", currentResult.label);

    // 如果是强制停止，可以在ui中额外弹出一个报警
    if (isForced) {
      currentResult.isForcedStopped = true;
      this.resetLoop(); //重置测试
    }
    if (this.currentLoopIndex === 1) {
      this.firstLoopResult = currentResult; // 存下第一轮
    } else {
      // 如果是第二轮，计算对比差异 (PDF: 两次峰值差/两次最大峰值)
      if (this.firstLoopResult) {
        const p1 = this.firstLoopResult.peakValue;
        const p2 = currentResult.peakValue;
        currentResult.percentageDiff =
          (Math.abs(p1 - p2) / Math.max(p1, p2)) * 100;
      }
    }
    // “发射信号”：计算完成，把结果发给 UI
    this.onResultReady?.(currentResult);
  }

  getDrawingPoints(): RawPoint[] {
    return this.displayBuffer;
  }

  getStartTime(): number {
    return this.measureStartTime;
  }

  /** 获取第一轮测量的起始时间 */
  getFirstLoopStartTime(): number {
    return this.firstLoopStartTime;
  }

  /** 获取第一轮的备份数据 (用于 Canvas 绘图对比) */
  getFirstLoopPoints(): RawPoint[] {
    return this.firstLoopResult?.points || [];
  }

  /** 获取第一轮的完整测量结果 (用于 CSV 导出) */
  getFirstLoopResult(): MeasurementResult | null {
    return this.firstLoopResult;
  }

  /** 重置 Loop 状态 (长时间没有结束测试，触发报警强制停止时调用) */
  resetLoop() {
    this.firstLoopResult = null;
    this.currentLoopIndex = 1;
    //this.displayBuffer = [];  //这个清空的话，ROM页面的角度就画不出来了
  }

  getCurrentLoopIndex(): number {
    //console.log(this.currentLoopIndex);
    return this.currentLoopIndex;
  }

  /** 获取当前测量标签 */
  getCurrentLabel(): string {
    return this.currentLabel;
  }

  /**  彻底复位：清除所有数据和曲线，长按归零键时使用  */
  fullReset() {
    this.rawBuffer = [];
    this.displayBuffer = [];
    this.firstLoopResult = null;
    this.currentLoopIndex = 1;
    this.baseline = 0;
    this.baselineAngle = 0;

    // 重置滤波器状态
    this.filteredForce = 0;
    this.filteredAngle = 0;
    this.isFilterInitialized = false;
    this._updateState(MeasureState.IDLE);
    console.log("引擎已彻底重置");
  }

  /** 仅重置状态：蓝牙断开时使用，保留测量数据 */
  private _resetStateOnly() {
    // 清理超时计时器
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    // 只重置状态相关，不清空数据
    this.baseline = 0;
    this.baselineAngle = 0;

    this.lowForceCounter = 0;
    // 重置滤波器状态
    this.filteredForce = 0;
    this.filteredAngle = 0;
    this.isFilterInitialized = false;
    this._updateState(MeasureState.IDLE);
    console.log("引擎状态已重置（数据已保留）");
  }
}
