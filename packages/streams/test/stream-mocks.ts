import { BaseDuplexStream, makeAck } from '../src/BaseDuplexStream.ts';
import type {
  Dispatch,
  ReceiveInput,
  BaseReaderArgs,
  OnEnd,
  ValidateInput,
} from '../src/BaseStream.ts';
import { BaseReader, BaseWriter } from '../src/BaseStream.ts';

/**
 * A test reader that exposes its receiveInput function for testing purposes.
 */
export class TestReader<Read = number> extends BaseReader<Read> {
  readonly #receiveInput: ReceiveInput;

  /**
   * Gets the receive input function for this reader.
   *
   * @returns The receive input function.
   */
  get receiveInput(): ReceiveInput {
    return this.#receiveInput;
  }

  /**
   * Constructs a new {@link TestReader}.
   *
   * @param args - Options bag for configuring the reader.
   */
  constructor(args: Omit<BaseReaderArgs<Read>, 'listen'> = {}) {
    let receiveInput!: ReceiveInput;
    super({
      ...args,
      listen: (receive) => {
        receiveInput = receive as ReceiveInput;
      },
    });
    this.#receiveInput = receiveInput;
  }
}

export class TestWriter<Write = number> extends BaseWriter<Write> {}

type TestDuplexStreamOptions<Read = number> = {
  validateInput?: ValidateInput<Read> | undefined;
  onEnd?: OnEnd | undefined;
};

/**
 * A test duplex stream that exposes its receiveInput function for testing purposes.
 */
export class TestDuplexStream<
  Read = number,
  Write = Read,
> extends BaseDuplexStream<Read, Write> {
  readonly #receiveInput: ReceiveInput;

  /**
   * Gets the receive input function for the underlying reader.
   *
   * @returns The receive input function.
   */
  get receiveInput(): ReceiveInput {
    return this.#receiveInput;
  }

  /**
   * Constructs a new {@link TestDuplexStream}.
   *
   * @param onDispatch - The dispatch function to use for writing.
   * @param options - Options bag for configuring the stream.
   * @param options.validateInput - A function that validates input from the transport.
   * @param options.onEnd - A function that is called once when the stream ends.
   */
  constructor(
    onDispatch: Dispatch<Write>,
    { validateInput, onEnd }: TestDuplexStreamOptions<Read> = {},
  ) {
    let receiveInput!: ReceiveInput;
    super({
      name: 'TestDuplexStream',
      validateInput,
      onEnd,
      onDispatch,
      listen: (receive) => {
        receiveInput = receive as ReceiveInput;
      },
    });
    this.#receiveInput = receiveInput;
  }

  /**
   * Synchronize the stream by receiving an ack.
   *
   * @returns A promise that resolves when the stream is synchronized.
   */
  async completeSynchronization(): Promise<void> {
    const syncP = super.synchronize().catch(() => undefined);
    await this.receiveInput(makeAck());
    return syncP;
  }

  /**
   * Make a new TestDuplexStream and synchronize it.
   *
   * @param onDispatch - The dispatch function to use.
   * @param opts - The options to use.
   * @returns A synchronized TestDuplexStream.
   */
  static async make<Read = number, Write = Read>(
    onDispatch: Dispatch<Write>,
    opts: TestDuplexStreamOptions<Read> = {},
  ): Promise<TestDuplexStream<Read, Write>> {
    const stream = new TestDuplexStream<Read, Write>(onDispatch, opts);
    await stream.completeSynchronization();
    return stream;
  }
}
