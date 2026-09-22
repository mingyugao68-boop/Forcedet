// miniprogram/utils/storage/BaseStorage.ts
import { MeasurementResult } from "../shared/types";

/**保存历史5次数据的基类，用于绘制历史趋势曲线 */
export class BaseStorage {
  private key: string;
  private readonly MAX_ITEMS = 5;

  /**
   * @param storageKey 微信本地存储的 Key
   */
  constructor(storageKey: string) {
    this.key = storageKey;
  }

  /** 保存一条记录，维护 5 条的上限 */
  save(res: MeasurementResult) {
    let list = this.getAll();
    list.unshift(res);
    // 只取前 5 条
    if (list.length > this.MAX_ITEMS) {
      list = list.slice(0, this.MAX_ITEMS);
    }
    wx.setStorageSync(this.key, list);
  }

  /** 获取所有历史记录*/
  getAll(): MeasurementResult[] {
    return wx.getStorageSync(this.key) || [];
  }

  /**
   * 解析标签中的部位和动作信息
   * 标签格式：侧别_部位_动作-时间
   * 例如：左_肩关节_屈曲-20240101_1430
   */
  private parseLabel(label: string): { bodyPart: string; action: string } {
    const defaultResult = { bodyPart: "", action: "" };

    try {
      const parts = label.split("_");
      if (parts.length < 2) return defaultResult;

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
      let bodyPart = "";
      let action = bodyPartAction;

      for (const part of bodyParts) {
        if (bodyPartAction.includes(part)) {
          bodyPart = part;
          // 移除部位名称，并清理可能残留的下划线
          action = bodyPartAction.replace(part, "").replace(/^_+|_+$/g, "");
          break;
        }
      }

      return { bodyPart, action };
    } catch (error) {
      return defaultResult;
    }
  }

  /**
   * 通用趋势分析函数
   * @param field 要对比的字段名
   * @description 根据最新数据的部位和动作筛选历史数据进行对比
   */
  getTrend(field: keyof MeasurementResult) {
    const list = this.getAll();

    // 如果少于2条，没法比，返回初始状态
    if (list.length < 2) {
      return { val: "0.0", percent: "0%", isIncrease: true };
    }

    // 获取最新数据的部位和动作
    const latestItem = list[0];
    const { bodyPart, action } = this.parseLabel(latestItem.label);

    // 如果无法解析部位和动作，使用原有逻辑
    if (!bodyPart && !action) {
      const latest = latestItem[field] as number;
      const prev = list[1][field] as number;
      const diff = latest - prev;
      const percent =
        prev === 0 ? "0" : ((Math.abs(diff) / prev) * 100).toFixed(1);

      return {
        val: Math.abs(diff).toFixed(1),
        percent: percent + "%",
        isIncrease: diff >= 0,
      };
    }

    // 根据部位和动作筛选历史数据
    const filteredList = list.filter((item) => {
      const parsed = this.parseLabel(item.label);
      return parsed.bodyPart === bodyPart && parsed.action === action;
    });

    // 如果筛选后少于2条，返回初始状态
    if (filteredList.length < 2) {
      return { val: "0.0", percent: "0%", isIncrease: true };
    }

    // 计算趋势
    const latest = filteredList[0][field] as number;
    const prev = filteredList[1][field] as number;
    const diff = latest - prev;
    const percent =
      prev === 0 ? "0" : ((Math.abs(diff) / prev) * 100).toFixed(1);

    return {
      val: Math.abs(diff).toFixed(1),
      percent: percent + "%",
      isIncrease: diff >= 0,
    };
  }

  /** 清空该项历史 */
  clear() {
    wx.removeStorageSync(this.key);
  }
}
