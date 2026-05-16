export interface IpcMainLike {
  handle<TResult = unknown>(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => Promise<TResult> | TResult,
  ): void;
}

export interface MessageBusLike {
  request<TRequest, TResult>(channel: string, request: TRequest): Promise<TResult>;
}

export interface GuiMutationPayload {
  channel: string;
  args: unknown[];
}

export interface DelegatedGuiMutation<TRequest = unknown> {
  channel: string;
  request: TRequest;
}

export interface IpcRegistrationOptions<TPriority extends string> {
  ipcMain: IpcMainLike;
  guiMutationHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
  workflowMutationDispatcher: Map<string, (...args: unknown[]) => Promise<unknown>>;
  isOwnerMode(): boolean;
  getMessageBus(): MessageBusLike;
  translateGuiMutationToHeadless(payload: GuiMutationPayload): DelegatedGuiMutation | null;
  isMissingOwnerError(error: unknown): boolean;
  runWorkflowMutation<TResult>(
    workflowId: string | undefined,
    priority: TPriority,
    channel: string,
    args: unknown[],
    op: () => Promise<TResult>,
  ): Promise<TResult>;
}

export interface IpcRegistration<TPriority extends string> {
  readonly registeredChannels: readonly string[];
  registerGuiMutationHandler<TResult = unknown>(
    channel: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void;
  registerWorkflowScopedGuiMutationHandler<TResult = unknown>(
    channel: string,
    resolveWorkflowId: (...args: unknown[]) => string | undefined,
    priority: TPriority,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void;
}

export function createIpcRegistration<TPriority extends string>(
  options: IpcRegistrationOptions<TPriority>,
): IpcRegistration<TPriority> {
  const registeredChannels: string[] = [];

  const registerGuiMutationHandler = <TResult = unknown>(
    channel: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void => {
    registeredChannels.push(channel);
    options.guiMutationHandlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
    options.ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      if (options.isOwnerMode()) {
        return handler(...args);
      }
      const translated = options.translateGuiMutationToHeadless({ channel, args });
      if (!translated) {
        throw new Error(`No owner delegation route is available for ${channel}`);
      }
      try {
        return await options.getMessageBus().request<typeof translated.request, TResult>(
          translated.channel,
          translated.request,
        );
      } catch (err) {
        if (options.isMissingOwnerError(err)) {
          throw new Error('No mutation owner is available');
        }
        throw err;
      }
    });
  };

  const registerWorkflowScopedGuiMutationHandler = <TResult = unknown>(
    channel: string,
    resolveWorkflowId: (...args: unknown[]) => string | undefined,
    priority: TPriority,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void => {
    options.workflowMutationDispatcher.set(channel, (...args: unknown[]) => handler(...args));
    registerGuiMutationHandler(channel, async (...args: unknown[]) => {
      const workflowId = resolveWorkflowId(...args);
      return options.runWorkflowMutation(workflowId, priority, channel, args, () => handler(...args));
    });
  };

  return {
    get registeredChannels() {
      return [...registeredChannels];
    },
    registerGuiMutationHandler,
    registerWorkflowScopedGuiMutationHandler,
  };
}
