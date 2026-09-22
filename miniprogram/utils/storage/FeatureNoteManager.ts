// miniprogram/utils/storage/FeatureNoteManager.ts
import { MeasurementResult } from "../shared/types";

/**
 * 测量特征数据接口
 */
export interface FeatureNote {
  _id?: string;

  // 时间信息
  timestamp: number; // 测量时间戳 (ms)
  createTime: Date; // 数据库创建时间

  // 测量配置
  side: string; // 侧别：左/右
  bodyPart: string; // 部位：颈椎、肩关节等
  action: string; // 动作：屈曲、伸展等
  label: string; // 完整标签

  // 测量特征数据
  peakValue: number; // 力峰值 (kg)
  rfdValue: number; // RFD (kg/s)
  durationValue: number; // 保持时间 (s)
  activityValue: number; // 运动时间 (s)
  percentageDiff: number; // 对比差异 (%)
  romPeak: number; // ROM角度峰值 (deg)
  romChange: number; // ROM变化百分比

  // 扩展字段
  isTwoLoops: boolean; // 是否为双侧对比测量
  firstLoopData?: {
    // 第一轮数据（双侧对比时）
    peakValue: number;
    rfdValue: number;
    durationValue: number;
    activityValue: number;
    romPeak: number;
    romChange: number;
  };
  notes?: string; // 用户备注

  // 元数据
  deviceId?: string; // 设备ID
  userId?: string; // 用户ID
}

/**
 * 特征数据管理类
 * 负责将测量特征数据保存到云数据库
 */
export class FeatureNoteManager {
  /** 数据库集合名称 */
  private static readonly COLLECTION_NAME = "featureNote";

  /** 本地缓存 */
  private static cache = new Map<
    string,
    {
      data: FeatureNote[];
      timestamp: number;
    }
  >();

  /** 缓存过期时间（5分钟） */
  private static readonly CACHE_EXPIRE_TIME = 5 * 60 * 1000;

  /**
   * 生成缓存键
   */
  private static getCacheKey(
    bodyPart: string,
    action: string,
    side?: string,
  ): string {
    return side ? `${bodyPart}-${action}-${side}` : `${bodyPart}-${action}`;
  }

  /**
   * 获取缓存数据
   */
  private static getFromCache(key: string): FeatureNote[] | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    // 检查是否过期
    if (Date.now() - cached.timestamp > this.CACHE_EXPIRE_TIME) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  /**
   * 设置缓存数据
   */
  private static setToCache(key: string, data: FeatureNote[]): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * 清除缓存
   */
  private static clearCache(): void {
    this.cache.clear();
  }

  /**
   * 保存测量特征数据到云端
   * @param res 测量结果
   * @param firstLoopResult 第一轮测量结果
   * @returns 保存结果
   */
  static async saveFeatureNote(
    res: MeasurementResult,
    firstLoopResult?: MeasurementResult | null,
  ): Promise<{ success: boolean; recordId?: string; message: string }> {
    try {
      const db = wx.cloud.database();

      // 解析标签信息
      const parsedInfo = this.parseLabel(res.label);

      // 判断是否为双侧对比测量
      const isTwoLoops = firstLoopResult && firstLoopResult.points.length > 0;

      // 构建特征数据
      const featureNote: FeatureNote = {
        timestamp: Date.now(),
        createTime: db.serverDate() as any,

        // 测量配置
        side: parsedInfo.side,
        bodyPart: parsedInfo.bodyPart,
        action: parsedInfo.action,
        label: res.label,

        // 测量特征数据
        peakValue: res.peakValue,
        rfdValue: res.rfdValue,
        durationValue: res.durationValue,
        activityValue: res.activityValue,
        percentageDiff: res.percentageDiff,
        romPeak: res.imuPeak,
        romChange: res.imuAngle,

        // 扩展字段
        isTwoLoops: isTwoLoops,
      };

      // 如果是双侧对比测量，添加第一轮数据
      if (isTwoLoops && firstLoopResult) {
        featureNote.firstLoopData = {
          peakValue: firstLoopResult.peakValue,
          rfdValue: firstLoopResult.rfdValue,
          durationValue: firstLoopResult.durationValue,
          activityValue: firstLoopResult.activityValue,
          romPeak: firstLoopResult.imuPeak,
          romChange: firstLoopResult.imuAngle,
        };
      }

      // 保存到数据库
      const result = await db.collection(this.COLLECTION_NAME).add({
        data: featureNote,
      });

      console.log("特征数据保存成功:", result._id);

      // 清除缓存
      this.clearCache();

      return {
        success: true,
        recordId: result._id,
        message: "特征数据保存成功",
      };
    } catch (error: any) {
      console.error("保存特征数据失败:", error);
      return {
        success: false,
        message: error.message || "保存失败",
      };
    }
  }

  /**
   * 解析标签信息
   * 标签格式：侧别_部位_动作-时间
   * 例如：左_肩关节_屈曲-20240101_1430
   */
  private static parseLabel(label: string): {
    side: string;
    bodyPart: string;
    action: string;
  } {
    const defaultResult = {
      side: "未知",
      bodyPart: "未知",
      action: "未知",
    };

    try {
      // 分割标签
      const parts = label.split("_");
      if (parts.length < 2) return defaultResult;

      // 提取侧别
      const side = parts[0];

      // 提取部位和动作
      const rest = parts.slice(1).join("_");
      const actionParts = rest.split("-");
      if (actionParts.length < 1) return defaultResult;

      const bodyPartAction = actionParts[0];

      // 定义所有可能的部位
      const bodyParts = [
        "颈椎",
        "胸椎",
        "腰椎",
        "肩关节",
        "肘关节",
        "腕关节",
        "髋关节",
        "膝关节",
        "踝关节",
      ];

      // 查找部位
      let bodyPart = "未知";
      let action = bodyPartAction;

      for (const part of bodyParts) {
        if (bodyPartAction.includes(part)) {
          bodyPart = part;
          // 移除部位名称，并清理可能残留的下划线
          action = bodyPartAction.replace(part, "").replace(/^_+|_+$/g, "");
          break;
        }
      }

      return { side, bodyPart, action };
    } catch (error) {
      console.error("解析标签失败:", error);
      return defaultResult;
    }
  }

  /**
   * 获取历史特征数据列表
   * @param limit 返回数量，默认20条
   */
  static async getFeatureNoteList(limit: number = 20): Promise<FeatureNote[]> {
    try {
      const db = wx.cloud.database();
      const result = await db
        .collection(this.COLLECTION_NAME)
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();

      return result.data as FeatureNote[];
    } catch (error) {
      console.error("获取特征数据列表失败:", error);
      return [];
    }
  }

  /**
   * 根据条件查询特征数据
   * @param condition 查询条件
   */
  static async queryFeatureNotes(condition: {
    side?: string; // 侧别
    bodyPart?: string; // 部位
    action?: string; // 动作
    startDate?: number; // 开始时间戳
    endDate?: number; // 结束时间戳
    limit?: number; // 返回数量
  }): Promise<FeatureNote[]> {
    try {
      const db = wx.cloud.database();
      const _ = db.command;

      // 构建查询条件
      let query: any = {};

      if (condition.side) {
        query.side = condition.side;
      }
      if (condition.bodyPart) {
        query.bodyPart = condition.bodyPart;
      }
      if (condition.action) {
        query.action = condition.action;
      }
      if (condition.startDate || condition.endDate) {
        query.timestamp = {};
        if (condition.startDate) {
          query.timestamp = _.gte(condition.startDate);
        }
        if (condition.endDate) {
          query.timestamp = _.and(query.timestamp, _.lte(condition.endDate));
        }
      }

      // 执行查询
      const limit = condition.limit || 50;
      const result = await db
        .collection(this.COLLECTION_NAME)
        .where(query)
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();

      return result.data as FeatureNote[];
    } catch (error) {
      console.error("查询特征数据失败:", error);
      return [];
    }
  }

  /**
   * 获取指定部位的历史趋势数据
   * @param bodyPart 部位名称
   * @param side 侧别
   * @param limit 返回数量
   */
  static async getTrendData(
    bodyPart: string,
    side: string,
    limit: number = 10,
  ): Promise<FeatureNote[]> {
    try {
      const db = wx.cloud.database();
      const result = await db
        .collection(this.COLLECTION_NAME)
        .where({
          bodyPart: bodyPart,
          side: side,
        })
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();

      return result.data as FeatureNote[];
    } catch (error) {
      console.error("获取趋势数据失败:", error);
      return [];
    }
  }

  /**
   * 获取趋势对比数据（用于显示较上次变化）
   * 只计算云数据库中最近两次数据的对比
   * @param bodyPart 部位名称
   * @param action 动作名称
   * @returns 趋势对比结果
   */
  static async getTrendComparison(
    bodyPart: string,
    action: string,
  ): Promise<{ val: string; percent: string; isIncrease: boolean }> {
    const defaultResult = { val: "0.0", percent: "0%", isIncrease: true };

    try {
      // 尝试从缓存获取
      const cacheKey = this.getCacheKey(bodyPart, action);
      let data = this.getFromCache(cacheKey);

      // 缓存未命中，查询数据库
      if (!data) {
        const db = wx.cloud.database();
        const result = await db
          .collection(this.COLLECTION_NAME)
          .where({
            bodyPart: bodyPart,
            action: action,
          })
          .orderBy("timestamp", "desc")
          .limit(10) // 缓存10条数据，提升后续查询性能
          .get();

        data = result.data as FeatureNote[];
        this.setToCache(cacheKey, data);
      }

      // 如果少于2条，无法对比
      if (data.length < 2) {
        return defaultResult;
      }

      // 计算趋势：云端最近两次数据对比
      const latest = data[0].peakValue as number;
      const prev = data[1].peakValue as number;
      const diff = latest - prev;
      const percent =
        prev === 0 ? "0" : ((Math.abs(diff) / prev) * 100).toFixed(1);

      return {
        val: Math.abs(diff).toFixed(1),
        percent: percent + "%",
        isIncrease: diff >= 0,
      };
    } catch (error) {
      console.error("获取趋势对比数据失败:", error);
      return defaultResult;
    }
  }

  /**
   * 获取ROM趋势对比数据
   * 只计算云数据库中最近两次数据的对比
   * @param bodyPart 部位名称
   * @param action 动作名称
   * @returns 趋势对比结果
   */
  static async getRomTrendComparison(
    bodyPart: string,
    action: string,
  ): Promise<{ val: string; percent: string; isIncrease: boolean }> {
    const defaultResult = { val: "0.0", percent: "0%", isIncrease: true };

    try {
      // 尝试从缓存获取（与 getTrendComparison 共用缓存）
      const cacheKey = this.getCacheKey(bodyPart, action);
      let data = this.getFromCache(cacheKey);

      // 缓存未命中，查询数据库
      if (!data) {
        const db = wx.cloud.database();
        const result = await db
          .collection(this.COLLECTION_NAME)
          .where({
            bodyPart: bodyPart,
            action: action,
          })
          .orderBy("timestamp", "desc")
          .limit(10)
          .get();

        data = result.data as FeatureNote[];
        this.setToCache(cacheKey, data);
      }

      // 如果少于2条，无法对比
      if (data.length < 2) {
        return defaultResult;
      }

      // 计算趋势：云端最近两次数据对比
      const latest = data[0].romPeak as number;
      const prev = data[1].romPeak as number;
      const diff = latest - prev;
      const percent =
        prev === 0 ? "0" : ((Math.abs(diff) / prev) * 100).toFixed(1);

      return {
        val: Math.abs(diff).toFixed(1),
        percent: percent + "%",
        isIncrease: diff >= 0,
      };
    } catch (error) {
      console.error("获取ROM趋势对比数据失败:", error);
      return defaultResult;
    }
  }

  /**
   * 更新特征数据备注
   * @param recordId 记录ID
   * @param notes 备注内容
   */
  static async updateNotes(recordId: string, notes: string): Promise<boolean> {
    try {
      const db = wx.cloud.database();
      await db
        .collection(this.COLLECTION_NAME)
        .doc(recordId)
        .update({
          data: {
            notes: notes,
          },
        });

      return true;
    } catch (error) {
      console.error("更新备注失败:", error);
      return false;
    }
  }

  /**
   * 删除特征数据记录
   * @param recordId 记录ID
   */
  static async deleteFeatureNote(recordId: string): Promise<boolean> {
    try {
      const db = wx.cloud.database();
      await db.collection(this.COLLECTION_NAME).doc(recordId).remove();

      return true;
    } catch (error) {
      console.error("删除特征数据失败:", error);
      return false;
    }
  }

  /**
   * 获取统计数据
   * @param bodyPart 部位
   * @param side 侧别
   */
  static async getStatistics(
    bodyPart: string,
    side: string,
  ): Promise<{
    count: number;
    avgPeak: number;
    maxPeak: number;
    minPeak: number;
    avgRFD: number;
  } | null> {
    try {
      const db = wx.cloud.database();
      const _ = db.command;

      // 获取该部位和侧别的所有数据
      const result = await db
        .collection(this.COLLECTION_NAME)
        .where({
          bodyPart: bodyPart,
          side: side,
        })
        .limit(100)
        .get();

      const data = result.data as FeatureNote[];

      if (data.length === 0) {
        return null;
      }

      // 计算统计数据
      const peaks = data.map((d) => d.peakValue);
      const rfds = data.map((d) => d.rfdValue);

      return {
        count: data.length,
        avgPeak: peaks.reduce((a, b) => a + b, 0) / peaks.length,
        maxPeak: Math.max(...peaks),
        minPeak: Math.min(...peaks),
        avgRFD: rfds.reduce((a, b) => a + b, 0) / rfds.length,
      };
    } catch (error) {
      console.error("获取统计数据失败:", error);
      return null;
    }
  }
}
