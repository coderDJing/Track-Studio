/**
 * worker.terminate() 不会触发 worker 进程内的 process.exit hook。
 * Dynamic sidecar 因此必须在终止前清理一次，并在 terminate 成功或失败后都再次清理。
 * 清理动作由 workerPool 统一持有，queue 只负责在正确时机调用。
 */
export const terminateWorkerWithDynamicSidecarCleanup = <
  TWorker extends {
    terminate: () => Promise<unknown>
  }
>(
  worker: TWorker,
  cleanup: (worker: TWorker) => void,
  onSettled?: () => void
): Promise<unknown> =>
  new Promise((resolve) => {
    cleanup(worker)
    worker
      .terminate()
      .then(
        (result) => result,
        () => {
          // 保持既有语义：terminate 失败被吞掉，onSettled 只在错误路径触发。
          onSettled?.()
          return undefined
        }
      )
      .finally(() => {
        cleanup(worker)
      })
      .then(resolve)
  })
