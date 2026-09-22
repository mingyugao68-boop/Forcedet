// miniprogram/utils/storage/FileExporter.ts
import { MeasurementResult } from "../shared/types";

/**单次测量的统计值、原始数据导出本地csv */
export class FileExporter {
  /**
   * 将测量结果导出为 CSV 并打开分享
   * @param res 最后一次测量结果
   * @param firstLoopResult 第一轮测量结果
   */
  static async exportToCsv(
    res: MeasurementResult,
    firstLoopResult?: MeasurementResult | null,
  ) {
    // 1. 构建 CSV 内容 (Header)
    let csvContent = "\ufeff"; // 添加 BOM 头，防止 Excel 打开中文乱码

    // 判断是否为两次测量模式
    const isTwoLoops = firstLoopResult && firstLoopResult.points.length > 0;

    // 第一部分：摘要信息 (Summary)
    csvContent += `测量标签,${res.label}\n`;
    if (isTwoLoops) {
      // 两次测量模式：横向排布，第一次测量在AB列，第二次测量在FG列
      csvContent += `左-力峰值(kg),${firstLoopResult.peakValue},,,,右-力峰值(kg),${res.peakValue}\n`;
      csvContent += `左-RFD(kg/s),${firstLoopResult.rfdValue},,,,右-RFD(kg/s),${res.rfdValue}\n`;
      csvContent += `左-运动时间(s),${firstLoopResult.activityValue},,,,右-运动时间(s),${res.activityValue}\n`;
      csvContent += `左-保持时间(s),${firstLoopResult.durationValue},,,,右-保持时间(s),${res.durationValue}\n`;
      csvContent += `对比差异,${res.percentageDiff.toFixed(2)}%\n\n`;
    } else {
      csvContent += `力峰值(kg),${res.peakValue}\n`;
      csvContent += `RFD(kg/s),${res.rfdValue}\n`;
      csvContent += `运动时间(s),${res.activityValue}\n`;
      csvContent += `保持时间(s),${res.durationValue}\n`;
      csvContent += `对比差异,${res.percentageDiff.toFixed(2)}%\n\n`;
    }

    // 第二部分：原始数据序列 (Raw Series)
    if (isTwoLoops) {
      // 两次测量模式：第一次测量数据保存至ABCD列，第二次测量数据保存至FGHI列
      csvContent += `时间戳(ms),相对时间(s),力量值(kg),角度(deg),,时间戳(ms),相对时间(s),力量值(kg),角度(deg)\n`;

      const startTime1 = firstLoopResult.points[0]?.t || 0;
      const startTime2 = res.points[0]?.t || 0;
      const maxLen = Math.max(firstLoopResult.points.length, res.points.length);

      for (let i = 0; i < maxLen; i++) {
        const p1 = firstLoopResult.points[i];
        const p2 = res.points[i];

        // 第一次测量数据 (ABCD列)
        if (p1) {
          const relTime1 = ((p1.t - startTime1) / 1000).toFixed(3);
          csvContent += `${p1.t},${relTime1},${p1.f},${p1.a},`;
        } else {
          csvContent += `,,,,`;
        }

        // 第二次测量数据 (FGHI列，E列为空分隔)
        csvContent += `,`; // E列空列分隔
        if (p2) {
          const relTime2 = ((p2.t - startTime2) / 1000).toFixed(3);
          csvContent += `${p2.t},${relTime2},${p2.f},${p2.a}`;
        }

        csvContent += `\n`;
      }
    } else {
      // 单次测量模式：保持原有格式
      csvContent += `时间戳(ms),相对时间(s),力量值(kg),角度(deg)\n`;

      const startTime = res.points[0]?.t || 0;
      res.points.forEach((p) => {
        const relTime = ((p.t - startTime) / 1000).toFixed(3);
        csvContent += `${p.t},${relTime},${p.f},${p.a}\n`;
      });
    }

    // 2. 写入手机本地临时文件
    const fs = wx.getFileSystemManager();
    const fileName = `Measure-${res.label.replace(/:/g, "")}.csv`;
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

    try {
      fs.writeFileSync(filePath, csvContent, "utf8");

      // 3. 调起微信文件预览/分享界面
      wx.openDocument({
        filePath: filePath,
        showMenu: true, // 允许用户转发给好友或保存到手机
        fileType: "csv",
        success: () => console.log("文件打开成功，用户可自行保存"),
        fail: (err) => wx.showToast({ title: "导出失败", icon: "none" }),
      });
    } catch (e) {
      console.error("文件写入失败", e);
    }
  }
}
