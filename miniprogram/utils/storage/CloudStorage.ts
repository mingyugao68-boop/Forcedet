// miniprogram/utils/storage/CloudStorage.ts
import { MeasurementResult } from "../shared/types";

/**
 * 云存储管理类
 * 负责将测量数据上传到微信云开发存储
 */
export class CloudStorage {
  /** 云存储文件夹名称 */
  private static readonly CLOUD_FOLDER = "historyTest";

  /**
   * 将测量结果上传到云存储
   * @param res 测量结果
   * @param firstLoopResult 第一轮测量结果
   * @returns 上传结果 { success, fileID, message }
   */
  static async uploadToCloud(
    res: MeasurementResult,
    firstLoopResult?: MeasurementResult | null,
  ): Promise<{ success: boolean; fileID?: string; message: string }> {
    try {
      // 1. 构建 CSV 内容
      const csvContent = this.buildCsvContent(res, firstLoopResult);

      // 2. 生成云存储文件路径
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sanitizedLabel = res.label.replace(/[:/\s]/g, "_");
      const cloudPath = `${this.CLOUD_FOLDER}/${sanitizedLabel}-${timestamp}.csv`;

      // 3. 先保存到本地临时文件
      const fs = wx.getFileSystemManager();
      const tempFilePath = `${wx.env.USER_DATA_PATH}/temp_${Date.now()}.csv`;
      fs.writeFileSync(tempFilePath, csvContent, "utf8");

      // 4. 上传到云存储
      let uploadResult = null;
      let lastError: any = null;
      const maxRetries = 3;

      for (let i = 0; i < maxRetries; i++) {
        try {
          console.log(`尝试上传云存储 (第${i + 1}次)...`);
          uploadResult = await wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: tempFilePath,
          });
          console.log("云存储上传成功:", uploadResult.fileID);
          break; // 成功则跳出循环
        } catch (error: any) {
          lastError = error;
          console.error(`第${i + 1}次上传失败:`, error.message);

          // 如果不是最后一次尝试，等待一段时间后重试
          if (i < maxRetries - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
          }
        }
      }

      // 5. 删除临时文件
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn("删除临时文件失败:", e);
      }

      // 6. 检查上传结果
      if (!uploadResult) {
        // 上传失败，但仍然保存到数据库
        console.warn("云存储上传失败，仅保存特征数据到数据库");
        return {
          success: false,
          message: `云存储上传失败: ${lastError?.message || "网络错误"}，但特征数据已保存到数据库`,
        };
      }

      // 7. 同时保存一份到云数据库
      await this.saveToDatabase(res, uploadResult.fileID, firstLoopResult);

      return {
        success: true,
        fileID: uploadResult.fileID,
        message: "数据已成功保存到云端",
      };
    } catch (error: any) {
      console.error("云存储上传失败:", error);
      return {
        success: false,
        message: error.message || "上传失败，请稍后重试",
      };
    }
  }

  /**
   * 构建 CSV 文件内容
   */
  private static buildCsvContent(
    res: MeasurementResult,
    firstLoopResult?: MeasurementResult | null,
  ): string {
    let csvContent = "\ufeff"; // BOM 头，防止 Excel 中文乱码

    const isTwoLoops = firstLoopResult && firstLoopResult.points.length > 0;

    // 第一部分：摘要信息
    csvContent += `测量标签,${res.label}\n`;
    csvContent += `测量时间,${new Date().toLocaleString()}\n`;
    csvContent += `设备信息,ForceMeter\n\n`;

    if (isTwoLoops) {
      // 两次测量模式
      csvContent += `=== 第一次测量 ===\n`;
      csvContent += `力峰值(kg),${firstLoopResult.peakValue}\n`;
      csvContent += `RFD(kg/s),${firstLoopResult.rfdValue}\n`;
      csvContent += `运动时间(s),${firstLoopResult.activityValue}\n`;
      csvContent += `保持时间(s),${firstLoopResult.durationValue}\n`;
      csvContent += `IMU角度变化(deg),${firstLoopResult.imuAngle.toFixed(2)}\n`;
      csvContent += `IMU最大角度(deg),${firstLoopResult.imuPeak.toFixed(2)}\n\n`;

      csvContent += `=== 第二次测量 ===\n`;
      csvContent += `力峰值(kg),${res.peakValue}\n`;
      csvContent += `RFD(kg/s),${res.rfdValue}\n`;
      csvContent += `运动时间(s),${res.activityValue}\n`;
      csvContent += `保持时间(s),${res.durationValue}\n`;
      csvContent += `IMU角度变化(deg),${res.imuAngle.toFixed(2)}\n`;
      csvContent += `IMU最大角度(deg),${res.imuPeak.toFixed(2)}\n\n`;

      csvContent += `=== 对比分析 ===\n`;
      csvContent += `对比差异(%),${res.percentageDiff.toFixed(2)}\n\n`;
    } else {
      // 单次测量模式
      csvContent += `=== 测量结果 ===\n`;
      csvContent += `力峰值(kg),${res.peakValue}\n`;
      csvContent += `RFD(kg/s),${res.rfdValue}\n`;
      csvContent += `运动时间(s),${res.activityValue}\n`;
      csvContent += `保持时间(s),${res.durationValue}\n`;
      csvContent += `IMU角度变化(deg),${res.imuAngle.toFixed(2)}\n`;
      csvContent += `IMU最大角度(deg),${res.imuPeak.toFixed(2)}\n`;
      csvContent += `对比差异(%),${res.percentageDiff.toFixed(2)}\n\n`;
    }

    // 第二部分：原始数据序列
    if (isTwoLoops) {
      csvContent += `=== 原始数据 ===\n`;
      csvContent += `时间戳(ms),相对时间(s),力量值(kg),角度(deg),,时间戳(ms),相对时间(s),力量值(kg),角度(deg)\n`;

      const startTime1 = firstLoopResult.points[0]?.t || 0;
      const startTime2 = res.points[0]?.t || 0;
      const maxLen = Math.max(firstLoopResult.points.length, res.points.length);

      for (let i = 0; i < maxLen; i++) {
        const p1 = firstLoopResult.points[i];
        const p2 = res.points[i];

        if (p1) {
          const relTime1 = ((p1.t - startTime1) / 1000).toFixed(3);
          csvContent += `${p1.t},${relTime1},${p1.f},${p1.a},`;
        } else {
          csvContent += `,,,,`;
        }

        csvContent += `,`;
        if (p2) {
          const relTime2 = ((p2.t - startTime2) / 1000).toFixed(3);
          csvContent += `${p2.t},${relTime2},${p2.f},${p2.a}`;
        }

        csvContent += `\n`;
      }
    } else {
      csvContent += `=== 原始数据 ===\n`;
      csvContent += `时间戳(ms),相对时间(s),力量值(kg),角度(deg)\n`;

      const startTime = res.points[0]?.t || 0;
      res.points.forEach((p) => {
        const relTime = ((p.t - startTime) / 1000).toFixed(3);
        csvContent += `${p.t},${relTime},${p.f},${p.a}\n`;
      });
    }

    return csvContent;
  }

  /**
   * 保存测量记录到云数据库
   */
  private static async saveToDatabase(
    res: MeasurementResult,
    fileID: string,
    firstLoopResult?: MeasurementResult | null,
  ): Promise<void> {
    const db = wx.cloud.database();
    const isTwoLoops = firstLoopResult && firstLoopResult.points.length > 0;

    // 构建数据库记录
    const record: any = {
      label: res.label,
      fileID: fileID,
      timestamp: Date.now(),
      createTime: db.serverDate(),

      // 测量结果摘要
      summary: {
        peakValue: res.peakValue,
        rfdValue: res.rfdValue,
        activityValue: res.activityValue,
        durationValue: res.durationValue,
        imuAngle: res.imuAngle,
        imuPeak: res.imuPeak,
        percentageDiff: res.percentageDiff,
      },

      // 数据点数量
      pointCount: res.points.length,

      // 是否为双侧对比测量
      isTwoLoops: isTwoLoops,
    };

    // 如果是两次测量，添加第一次测量的摘要
    if (isTwoLoops && firstLoopResult) {
      record.firstLoopSummary = {
        peakValue: firstLoopResult.peakValue,
        rfdValue: firstLoopResult.rfdValue,
        activityValue: firstLoopResult.activityValue,
        durationValue: firstLoopResult.durationValue,
        imuAngle: firstLoopResult.imuAngle,
        imuPeak: firstLoopResult.imuPeak,
      };
    }

    // 解析标签信息（格式：侧别_部位_动作-时间）
    const labelParts = res.label.split("_");
    if (labelParts.length >= 2) {
      record.side = labelParts[0]; // 左/右
      const rest = labelParts.slice(1).join("_");
      const actionParts = rest.split("-");
      if (actionParts.length >= 2) {
        const bodyPartAction = actionParts[0];
        // 尝试分离部位和动作
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
        for (const part of bodyParts) {
          if (bodyPartAction.includes(part)) {
            record.bodyPart = part;
            record.action = bodyPartAction.replace(part, "");
            break;
          }
        }
      }
    }

    await db.collection("measurements").add({ data: record });
  }

  /**
   * 获取历史测量记录列表
   * @param limit 返回记录数量，默认20条
   */
  static async getHistoryList(limit: number = 20): Promise<any[]> {
    try {
      const db = wx.cloud.database();
      const result = await db
        .collection("measurements")
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();

      return result.data;
    } catch (error) {
      console.error("获取历史记录失败:", error);
      return [];
    }
  }

  /**
   * 根据条件查询测量记录
   * @param condition 查询条件 { side?, bodyPart?, action? }
   */
  static async queryRecords(condition: {
    side?: string;
    bodyPart?: string;
    action?: string;
  }): Promise<any[]> {
    try {
      const db = wx.cloud.database();
      let query = db.collection("measurements") as any;

      if (condition.side) {
        query = query.where({ side: condition.side });
      }
      if (condition.bodyPart) {
        query = query.where({ bodyPart: condition.bodyPart });
      }
      if (condition.action) {
        query = query.where({ action: condition.action });
      }

      const result = await query.orderBy("timestamp", "desc").limit(50).get();
      return result.data;
    } catch (error) {
      console.error("查询记录失败:", error);
      return [];
    }
  }

  /**
   * 删除云存储文件和数据库记录
   * @param recordId 数据库记录ID
   * @param fileID 云存储文件ID
   */
  static async deleteRecord(
    recordId: string,
    fileID: string,
  ): Promise<boolean> {
    try {
      // 1. 删除云存储文件
      await wx.cloud.deleteFile({ fileList: [fileID] });

      // 2. 删除数据库记录
      const db = wx.cloud.database();
      await db.collection("measurements").doc(recordId).remove();

      return true;
    } catch (error) {
      console.error("删除记录失败:", error);
      return false;
    }
  }
}
