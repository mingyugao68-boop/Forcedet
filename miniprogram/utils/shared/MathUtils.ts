// miniprogram/utils/shared/MathUtils.ts
import { RawPoint, MeasureState, MeasurementResult, HoldResult } from "./types";
export class MathUtils {
  /** 私有计算函数：实现 PDF 中的算法指标 */
  static calculateAllMetrics(rawBuffer: RawPoint[]): MeasurementResult {
    const data = rawBuffer;
    if (data.length === 0) return this.emptyResult();

    // 1. 峰值计算 (Peak)
    const peak = Math.max(...data.map((p) => p.f));

    // 2. RFD 计算 (10%-90% 陡峭部分的斜率)
    const rfd = this.calcRFD(data, peak);

    // 3. 运动时间 (Duration) data中就是超过阈值到回落阈值下的所有点
    const activityTime = (data[data.length - 1].t - data[0].t) / 1000; // 毫秒转秒

    // 4. 保持时间 (Duration) 双阈值滞回
    const holdRes = this.calculateHoldDuration(data, peak);

    //5.IMU最大值计算
    const imuPeak = Math.max(...data.map((p) => p.a));
    return {
      peakValue: Number(peak.toFixed(1)),
      rfdValue: Number(rfd.toFixed(1)),
      activityValue: Number(activityTime.toFixed(2)),
      durationValue: Number(holdRes.duration.toFixed(2)),
      isMultiplePeaks: holdRes.isMultiplePeaks,
      imuAngle: 0,
      imuPeak: imuPeak,
      imuTime: 0,
      percentageDiff: 0, // 第一次测量默认为0
      points: [...data], //使用 [...data] 进行浅拷贝，防止后续 buffer 被意外清空影响结果
      label: "", // 初始化占位，后面会被 stopAndCalculate 覆盖
      isForcedStopped: false,
    };
  }

  static calcRFD(data: RawPoint[], peak: number): number {
    const p10 = peak * 0.1;
    const p90 = peak * 0.9;
    const point1 = data.find((p) => p.f >= p10);
    const point2 = data.find((p) => p.f >= p90);
    const t1 = point1?.t ?? 0; //；链式调用，point1存在的话，返回point1.t。然后判断point1.t是null或者undefined的话，返回0，否则返回point1.t
    const t2 = point2?.t ?? 0;
    return t2 > t1 ? (p90 - p10) / ((t2 - t1) / 1000) : 0;
  }

  static emptyResult(): MeasurementResult {
    return {
      peakValue: 0,
      rfdValue: 0,
      activityValue: 0,
      durationValue: 0,
      isMultiplePeaks: false,
      imuAngle: 0,
      imuTime: 0,
      imuPeak: 0,
      percentageDiff: 0,
      points: [], // 空数组
      label: "", // 初始化占位
      isForcedStopped: false,
    };
  }

  /** 计算保持时间：双阈值滞回算法*/
  static calculateHoldDuration(points: RawPoint[], peak: number): HoldResult {
    if (points.length < 2 || peak <= 0)
      return { duration: 0, isMultiplePeaks: false };

    const startThreshold = peak * 0.9; // 开启阈值 (90%)
    const endThreshold = peak * 0.85; // 结束阈值 (85%)
    const secondPeakThreshold = peak * 0.95; // 二次发力检测阈值 (95%)，调高以减少误报

    let startIdx = -1;
    let endIdx = -1;
    let hasSecondPeak = false;

    // 1. 寻找第一次达到 90% Peak 的时刻 (开始计时)
    for (let i = 0; i < points.length; i++) {
      if (points[i].f >= startThreshold) {
        startIdx = i;
        break;
      }
    }

    if (startIdx === -1) return { duration: 0, isMultiplePeaks: false };

    // 2. 从开始时刻起，寻找第一次跌破 85% Peak 的时刻 (结束计时)
    for (let i = startIdx; i < points.length; i++) {
      if (points[i].f < endThreshold) {
        endIdx = i;
        break;
      }
    }

    // 如果一直没跌破，就以最后一个点作为结束点
    const finalEndIdx = endIdx === -1 ? points.length - 1 : endIdx;

    // 3. 检查结束时刻之后，是否又有超过 95% 的情况 (检测二次发力)
    // 阈值从 90% 提高到 95%，减少误报
    if (endIdx !== -1) {
      for (let i = endIdx; i < points.length; i++) {
        if (points[i].f >= secondPeakThreshold) {
          hasSecondPeak = true;
          break;
        }
      }
    }

    // 计算时长 (ms -> s)
    const durationMs = points[finalEndIdx].t - points[startIdx].t;
    const durationS = parseFloat((durationMs / 1000).toFixed(2));

    return {
      duration: durationS,
      isMultiplePeaks: hasSecondPeak,
    };
  }
}
