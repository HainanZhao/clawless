import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from '../utils/error.js';

export interface ScheduleConfig {
  id: string;
  cronExpression?: string;
  oneTime?: boolean;
  runAt?: Date;
  message: string;
  description?: string;
  createdAt: Date;
  lastRun?: Date;
  active: boolean;
}

export interface ScheduleJob {
  config: ScheduleConfig;
  task?: cron.ScheduledTask;
  timeout?: NodeJS.Timeout;
  inFlight?: boolean;
}

interface PersistedScheduleConfig {
  id: string;
  cronExpression?: string;
  oneTime?: boolean;
  runAt?: string;
  message: string;
  description?: string;
  createdAt: string;
  lastRun?: string;
  active: boolean;
}

export interface CronSchedulerOptions {
  persistenceFilePath?: string;
  timezone?: string;
  logInfo?: (message: string, details?: unknown) => void;
}

export class CronScheduler {
  private jobs: Map<string, ScheduleJob> = new Map();
  private jobCallback: (schedule: ScheduleConfig) => Promise<void>;
  private persistenceFilePath: string | null;
  private timezone: string;
  private logInfo: (message: string, details?: unknown) => void;

  constructor(callback: (schedule: ScheduleConfig) => Promise<void>, options: CronSchedulerOptions = {}) {
    this.jobCallback = callback;
    this.persistenceFilePath = options.persistenceFilePath || null;
    this.timezone = options.timezone || process.env.TZ || 'UTC';
    this.logInfo = options.logInfo || ((message: string, details?: unknown) => {
      if (details !== undefined) {
        console.log(`[CronScheduler] ${message}`, details);
      } else {
        console.log(`[CronScheduler] ${message}`);
      }
    });

    this.loadPersistedSchedules();
  }

  private validateScheduleConfig(config: ScheduleConfig): void {
    if (config.oneTime) {
      if (!config.runAt) {
        throw new Error('One-time schedules require a runAt date');
      }
      if (config.runAt <= new Date()) {
        throw new Error('One-time schedule runAt must be in the future');
      }
      return;
    }

    if (!config.cronExpression) {
      throw new Error('Recurring schedules require a cronExpression');
    }

    if (!cron.validate(config.cronExpression)) {
      throw new Error('Invalid cron expression');
    }
  }

  private configureRuntimeForJob(job: ScheduleJob): void {
    // Clean existing runtime handles first (used when toggling/reloading)
    if (job.task) {
      job.task.stop();
      job.task = undefined;
    }
    if (job.timeout) {
      clearTimeout(job.timeout);
      job.timeout = undefined;
    }

    const { config } = job;

    if (config.oneTime && config.runAt) {
      if (!config.active) {
        return;
      }

      const delay = config.runAt.getTime() - Date.now();
      if (delay <= 0) {
        return;
      }

      job.timeout = setTimeout(async () => {
        await this.executeJob(config.id);
        this.removeSchedule(config.id);
      }, delay);
      return;
    }

    if (config.cronExpression) {
      job.task = cron.schedule(
        config.cronExpression,
        async () => {
          await this.executeJob(config.id);
        },
        {
          timezone: this.timezone,
        }
      );

      if (!config.active) {
        job.task.stop();
      }
    }
  }

  private toPersistedSchedule(config: ScheduleConfig): PersistedScheduleConfig {
    return {
      id: config.id,
      cronExpression: config.cronExpression,
      oneTime: config.oneTime,
      runAt: config.runAt ? config.runAt.toISOString() : undefined,
      message: config.message,
      description: config.description,
      createdAt: config.createdAt.toISOString(),
      lastRun: config.lastRun ? config.lastRun.toISOString() : undefined,
      active: config.active,
    };
  }

  private parsePersistedSchedule(config: PersistedScheduleConfig): ScheduleConfig {
    return {
      id: config.id,
      cronExpression: config.cronExpression,
      oneTime: config.oneTime,
      runAt: config.runAt ? new Date(config.runAt) : undefined,
      message: config.message,
      description: config.description,
      createdAt: new Date(config.createdAt),
      lastRun: config.lastRun ? new Date(config.lastRun) : undefined,
      active: config.active,
    };
  }

  private persistSchedules(): void {
    if (!this.persistenceFilePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.persistenceFilePath), { recursive: true });
      const schedules = Array.from(this.jobs.values()).map((job) => this.toPersistedSchedule(job.config));
      fs.writeFileSync(this.persistenceFilePath, `${JSON.stringify({ schedules }, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.logInfo('Failed to persist schedules', {
        persistenceFilePath: this.persistenceFilePath,
        error: getErrorMessage(error),
      });
    }
  }

  private loadPersistedSchedules(): void {
    if (!this.persistenceFilePath) {
      return;
    }

    try {
      if (!fs.existsSync(this.persistenceFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.persistenceFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { schedules?: PersistedScheduleConfig[] };
      const schedules = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
      const now = new Date();

      for (const persisted of schedules) {
        const config = this.parsePersistedSchedule(persisted);

        // Drop one-time schedules that are already past due on restart
        if (config.oneTime && config.runAt && config.runAt <= now) {
          continue;
        }

        if (!config.oneTime && (!config.cronExpression || !cron.validate(config.cronExpression))) {
          this.logInfo('Skipping invalid persisted recurring schedule', { scheduleId: config.id });
          continue;
        }

        const job: ScheduleJob = { config };
        this.configureRuntimeForJob(job);
        this.jobs.set(config.id, job);
      }

      this.logInfo('Loaded persisted schedules', {
        count: this.jobs.size,
        persistenceFilePath: this.persistenceFilePath,
      });

      // Clean up persisted file if we dropped stale entries
      this.persistSchedules();
    } catch (error) {
      this.logInfo('Failed to load persisted schedules', {
        persistenceFilePath: this.persistenceFilePath,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Create a new schedule
   */
  createSchedule(config: Omit<ScheduleConfig, 'id' | 'createdAt' | 'active'>): ScheduleConfig {
    const scheduleConfig: ScheduleConfig = {
      ...config,
      id: this.generateId(),
      createdAt: new Date(),
      active: true,
    };

    this.validateScheduleConfig(scheduleConfig);

    const job: ScheduleJob = {
      config: scheduleConfig,
    };

    this.configureRuntimeForJob(job);

    this.jobs.set(scheduleConfig.id, job);
    this.persistSchedules();
    return scheduleConfig;
  }

  /**
   * Execute a scheduled job
   */
  private async executeJob(scheduleId: string): Promise<void> {
    const job = this.jobs.get(scheduleId);
    if (!job || !job.config.active) {
      return;
    }

    // Skip if job is already in flight (prevents overlapping executions)
    if (job.inFlight) {
      console.warn(`[CronScheduler] Job ${scheduleId} skipped - previous execution still in progress`);
      return;
    }

    job.inFlight = true;
    job.config.lastRun = new Date();
    this.persistSchedules();

    try {
      await this.jobCallback(job.config);
    } catch (error: any) {
      console.error(`[CronScheduler] Job ${scheduleId} execution failed: ${getErrorMessage(error)}`);
    } finally {
      job.inFlight = false;
    }
  }

  /**
   * Get a schedule by ID
   */
  getSchedule(scheduleId: string): ScheduleConfig | null {
    const job = this.jobs.get(scheduleId);
    return job ? job.config : null;
  }

  /**
   * List all schedules
   */
  listSchedules(): ScheduleConfig[] {
    return Array.from(this.jobs.values()).map(job => job.config);
  }

  /**
   * Remove a schedule
   */
  removeSchedule(scheduleId: string): boolean {
    const job = this.jobs.get(scheduleId);
    if (!job) {
      return false;
    }

    // Stop the cron task if it exists
    if (job.task) {
      job.task.stop();
    }

    // Clear timeout if it exists (for one-time jobs)
    if (job.timeout) {
      clearTimeout(job.timeout);
    }

    this.jobs.delete(scheduleId);
    this.persistSchedules();
    return true;
  }

  /**
   * Pause/resume a schedule
   */
  toggleSchedule(scheduleId: string, active: boolean): boolean {
    const job = this.jobs.get(scheduleId);
    if (!job) {
      return false;
    }

    job.config.active = active;

    if (job.task) {
      if (active) {
        job.task.start();
      } else {
        job.task.stop();
      }
    }

    this.persistSchedules();

    return true;
  }

  /**
   * Generate a unique ID for a schedule
   */
  private generateId(): string {
    return `schedule_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Shutdown all scheduled jobs
   */
  shutdown(): void {
    for (const [scheduleId] of this.jobs) {
      this.removeSchedule(scheduleId);
    }
  }
}
