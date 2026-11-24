/**
 * The crank a vat's work is charged to, kept by the supervisor so that a
 * callback the vat schedules during a delivery runs as that delivery's
 * work. The vat sees none of it; the crank number stays in the supervisor's
 * closures.
 *
 * A callback is charged to a crank for its own run and the microtasks that
 * follow it, which end before the next macrotask: the charge is lifted by a
 * timer of the supervisor's own queued as the callback starts.
 */
export class DeliveryContext {
  /** The crank of the delivery in progress, if one is. */
  #delivering: number | undefined;

  /** The crank a callback now running was scheduled in, if one is. */
  #scheduled: number | undefined;

  /** Numbers each callback run, so a lifted charge is only its own. */
  #runs = 0;

  /**
   * Whether a delivery is in progress.
   *
   * @returns True if one is.
   */
  get delivering(): boolean {
    return this.#delivering !== undefined;
  }

  /**
   * The crank the work now running is charged to, if any.
   *
   * @returns The crank, or undefined.
   */
  get crank(): number | undefined {
    return this.#delivering ?? this.#scheduled;
  }

  /**
   * Run a delivery as a crank's work.
   *
   * @param crankNumber - The crank, if the kernel said.
   * @param work - The delivery.
   * @returns What the delivery returns.
   */
  async deliver<Result>(
    crankNumber: number | undefined,
    work: () => Promise<Result>,
  ): Promise<Result> {
    this.#delivering = crankNumber;
    try {
      return await work();
    } finally {
      this.#delivering = undefined;
    }
  }

  /**
   * Charge what runs from now until the next macrotask to a crank, as a
   * callback scheduled in it starts.
   *
   * @param crankNumber - The crank, if the callback was scheduled in one.
   */
  resume(crankNumber: number | undefined): void {
    if (crankNumber === undefined) {
      return;
    }
    this.#runs += 1;
    const run = this.#runs;
    this.#scheduled = crankNumber;
    setTimeout(() => {
      if (this.#runs === run) {
        this.#scheduled = undefined;
      }
    }, 0);
  }

  /**
   * A timer whose callbacks are charged to the crank they were scheduled in.
   *
   * @param set - A `setTimeout` or `setInterval`.
   * @returns One that charges its callbacks.
   */
  timer<Set extends (handler: unknown, ...rest: unknown[]) => unknown>(
    set: Set,
  ): Set {
    const charging = (handler: unknown, ...rest: unknown[]): unknown => {
      if (typeof handler !== 'function') {
        return set(handler, ...rest);
      }
      const crankNumber = this.crank;
      return set(
        (...args: unknown[]) => {
          this.resume(crankNumber);
          return handler(...args);
        },
        ...rest,
      );
    };
    return harden(charging) as Set;
  }

  /**
   * A `fetch` whose responses, and their bodies, are charged to the crank
   * the request was made in.
   *
   * @param base - The `fetch`.
   * @returns One that charges what it returns.
   */
  fetch(base: typeof fetch): typeof fetch {
    const charging: typeof fetch = async (...args) => {
      const crankNumber = this.crank;
      let response: Response;
      try {
        response = await base(...args);
      } finally {
        this.resume(crankNumber);
      }
      return this.#chargingResponse(response, crankNumber);
    };
    return harden(charging);
  }

  /**
   * A response whose body reads are charged to a crank.
   *
   * @param response - The response.
   * @param crankNumber - The crank.
   * @returns The response, mirrored.
   */
  #chargingResponse(
    response: Response,
    crankNumber: number | undefined,
  ): Response {
    const charged = async <Result>(
      read: () => Promise<Result>,
    ): Promise<Result> => {
      try {
        return await read();
      } finally {
        this.resume(crankNumber);
      }
    };
    const mirrored = {
      get body() {
        return response.body;
      },
      get bodyUsed() {
        return response.bodyUsed;
      },
      get headers() {
        return response.headers;
      },
      get ok() {
        return response.ok;
      },
      get redirected() {
        return response.redirected;
      },
      get status() {
        return response.status;
      },
      get statusText() {
        return response.statusText;
      },
      get type() {
        return response.type;
      },
      get url() {
        return response.url;
      },
      arrayBuffer: async () => charged(async () => response.arrayBuffer()),
      blob: async () => charged(async () => response.blob()),
      bytes: async () =>
        charged(async () =>
          (response as Response & { bytes(): Promise<Uint8Array> }).bytes(),
        ),
      formData: async () => charged(async () => response.formData()),
      json: async () => charged(async () => response.json()),
      text: async () => charged(async () => response.text()),
      clone: () => this.#chargingResponse(response.clone(), crankNumber),
    };
    return harden(mirrored) as unknown as Response;
  }
}
harden(DeliveryContext);
