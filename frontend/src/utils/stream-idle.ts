/** Server emits heartbeats every few seconds, including during planning. */
export async function readWithIdleTimeout<T>(
  reader: { read(): Promise<T> },
  timeoutMs = 45000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("连接长时间无响应，服务可能已重启。请重新打开会话查看任务状态")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
