// miniprogram/utils/shared/CommonUtils.ts

export class CommonUtils {
  /**
   * 获取格式化的系统时间戳
   * @returns 返回字符串如 "0210_1430" (月日_时分)
   */
  static getFormattedTimestamp(): string {
    const now = new Date();

    // 月份是从 0 开始的，所以要 +1
    const M = (now.getMonth() + 1).toString().padStart(2, "0");
    const D = now.getDate().toString().padStart(2, "0");
    const h = now.getHours().toString().padStart(2, "0");
    const m = now.getMinutes().toString().padStart(2, "0");
    const s = now.getSeconds().toString().padStart(2, "0");

    // 不使用下划线，避免与文件名分隔符混淆
    return `${M}${D}${h}${m}${s}`;
  }

  /**
   * 获取更详细的展示时间
   * @returns "2026-02-10 14:30:05"
   */
  static getFullDateTime(): string {
    const now = new Date();
    return now.toLocaleString(); // 或者自定义格式
  }
}
