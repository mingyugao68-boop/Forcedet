// miniprogram/utils/painters/BasePainter.ts

/** 抽象绘图基类，封装初始化、绘图循环逻辑*/
export abstract class BasePainter {
  //子类可直接访问
  protected canvas: any;
  protected ctx: any;
  protected width: number = 0;
  protected height: number = 0;
  protected dpr: number = 1; //设备像素比

  constructor(canvasId: string, pageContext: any) {
    this._init(canvasId, pageContext); //画布id和页面上下文
  }

  /** 检查Canvas是否有效 */
  public isReady(): boolean {
    return this.ctx !== null && this.ctx !== undefined;
  }

  private _init(canvasId: string, pageContext: any) {
    const query = pageContext.createSelectorQuery();
    query
      .select("#" + canvasId) // 通过ID选择画布元素
      .fields({ node: true, size: true }) // 获取节点和尺寸信息
      .exec((res) => {
        //res是是查询结果数组
        // 异步回调
        if (!res[0]) {
          console.error(`无法找到 ID 为 ${canvasId} 的 Canvas，请检查 WXML`);
          return;
        }
        this.canvas = res[0].node; // 获取原生画布对象
        this.ctx = this.canvas.getContext("2d"); // 获取2D绘图上下文
        this.dpr = wx.getWindowInfo().pixelRatio; // 处理高分屏缩放

        // 统一处理高分屏缩放
        this.canvas.width = res[0].width * this.dpr; // 设置物理像素宽度
        this.canvas.height = res[0].height * this.dpr;
        this.ctx.scale(this.dpr, this.dpr);

        this.width = res[0].width;
        this.height = res[0].height;
        console.log(
          `Canvas 初始化完成: width=${this.width}, height=${this.height}, dpr=${this.dpr}, canvas.width=${this.canvas.width}, canvas.height=${this.canvas.height}`,
        );
        this._startRenderLoop();
      });
  }

  /** 渲染循环 */
  private _startRenderLoop() {
    const render = () => {
      this.drawFrame();
      this.canvas.requestAnimationFrame(render); // 请求下一帧
    };
    this.canvas.requestAnimationFrame(render); // 启动循环，自我调用形成循环
  }

  /** 子类必须实现的抽象方法 */
  abstract drawFrame(): void;
}
