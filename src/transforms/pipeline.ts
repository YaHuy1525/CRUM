export interface TransformStep<T = unknown, R = unknown> {
  name: string;
  description?: string;
  transform: (input: T) => R | Promise<R>;
  validate?: (input: T) => boolean;
  onError?: 'skip' | 'abort' | 'default';
  defaultValue?: R;
}

export class TransformPipeline<T = unknown> {
  private steps: TransformStep[] = [];
  private context: Record<string, unknown> = {};

  step<R>(
    name: string,
    transform: (input: T) => R | Promise<R>,
    options?: {
      description?: string;
      validate?: (input: T) => boolean;
      onError?: 'skip' | 'abort' | 'default';
      defaultValue?: R;
    }
  ): TransformPipeline<R> {
    this.steps.push({
      name,
      description: options?.description,
      transform: transform as (input: unknown) => unknown,
      validate: options?.validate as ((input: unknown) => boolean) | undefined,
      onError: options?.onError ?? 'abort',
      defaultValue: options?.defaultValue,
    });
    return this as unknown as TransformPipeline<R>;
  }

  setContext(key: string, value: unknown): this {
    this.context[key] = value;
    return this;
  }

  getContext(): Record<string, unknown> {
    return { ...this.context };
  }

  async execute(input: T): Promise<{ result: unknown; steps: StepResult[] }> {
    const stepResults: StepResult[] = [];
    let current: unknown = input;

    for (const step of this.steps) {
      const startTime = Date.now();
      const stepResult: StepResult = {
        name: step.name,
        status: 'pending',
        duration: 0,
      };

      try {
        if (step.validate && !step.validate(current)) {
          stepResult.status = 'skipped';
          stepResult.reason = 'Validation failed';
          stepResults.push(stepResult);
          
          if (step.onError === 'abort') {
            throw new Error(`Step ${step.name} validation failed`);
          }
          if (step.onError === 'default' && step.defaultValue !== undefined) {
            current = step.defaultValue;
          }
          continue;
        }

        const result = await step.transform(current);
        current = result;
        
        stepResult.status = 'success';
        stepResult.duration = Date.now() - startTime;
        stepResults.push(stepResult);
      } catch (err) {
        stepResult.status = 'failed';
        stepResult.duration = Date.now() - startTime;
        stepResult.error = err instanceof Error ? err.message : String(err);
        stepResults.push(stepResult);

        if (step.onError === 'abort') {
          throw err;
        }
        if (step.onError === 'default' && step.defaultValue !== undefined) {
          current = step.defaultValue;
        }
        if (step.onError === 'skip') {
          continue;
        }
      }
    }

    return { result: current, steps: stepResults };
  }

  getSteps(): Array<{ name: string; description?: string }> {
    return this.steps.map((s) => ({ name: s.name, description: s.description }));
  }
}

export interface StepResult {
  name: string;
  status: 'pending' | 'success' | 'failed' | 'skipped';
  duration: number;
  reason?: string;
  error?: string;
}

export function createPipeline<T>(): TransformPipeline<T> {
  return new TransformPipeline<T>();
}
