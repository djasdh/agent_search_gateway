/** 简单信号量：限制并发数，超出排队等待。 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.release;
    }
    // 排队者被唤醒时槽位已由 release() 直接转交，active 保持不变
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return this.release;
  }

  private release = (): void => {
    const next = this.queue.shift();
    if (next) {
      // 直接把槽位转交给队首：不先减 active，避免新来的 acquire 在这个窗口插队
      next();
      return;
    }
    this.active--;
  };
}
