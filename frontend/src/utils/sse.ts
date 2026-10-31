export interface SseEvent {
  event: string;
  data: string;
}

export class SseDecoder {
  private decoder = new TextDecoder();
  private buffer = "";

  feed(bytes: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain();
  }
  finish(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain();
  }
  private drain(): SseEvent[] {
    const events: SseEvent[] = [];
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) events.push({ event, data: data.join("\n") });
    }
    return events;
  }
}
