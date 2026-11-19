import {
  Card,
  FSRS,
  FSRSParameters,
  Grade,
  Rating,
  State,
  StepUnit,
  createEmptyCard,
  default_maximum_interval,
  default_request_retention,
  default_w,
  fsrs,
  generatorParameters,
} from 'ts-fsrs';

// ============================================================================
// Library-Agnostic Domain Types (UI and Stores MUST only import/use these)
// ============================================================================

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';
export type CardState = 'new' | 'learning' | 'review' | 'relearning';

export interface Flashcard {
  id: string;
  courseId: number;
  courseTitle: string;
  topicIndex: number;
  topicTitle: string;
  front: string;
  back: string;
  sourceCitation?: string | null;
  state: CardState;
  due: string | null;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: string | null;
  isLearned: boolean;
  isCustom: boolean;
  engineData?: Record<string, unknown> | null;
}

export interface SchedulingOption {
  rating: ReviewRating;
  intervalDays: number;
  intervalLabel: string;
  intervalLabelUk: string;
  nextDueIso: string;
  nextState: CardState;
}

export type SchedulingPreview = Record<ReviewRating, SchedulingOption>;

export interface SRSConfig {
  targetRetention: number; // 0.80 .. 0.98 (maps to FSRS request_retention)
  dailyMinutes: number; // e.g., 10, 20, 30, 45, 60
  avgSecondsPerCard: number; // rolling/user-calibrated seconds per card review
  newCardsLimit: number; // dynamically calibrated or custom-overridden
  dailyReviewLimit: number;
  learningSteps: number[]; // minutes, e.g., [1, 10]
  relearningSteps: number[]; // minutes, e.g., [10]
  maximumInterval: number; // days, e.g., 365
  enableFuzz: boolean;
  weights: number[]; // FSRS weights
  includeLearned: boolean;
  includeNew: boolean;
  courseIds: number[];
}

export interface AdaptiveCalibration {
  targetRetention: number;
  requestRetention: number;
  dailyMinutes: number;
  avgSecondsPerCard: number;
  newCardsLimit: number;
  estimatedNewCardMinutes: number;
  estimatedReviewMinutes: number;
  totalDailyCapacity: number;
  explanation: string;
}

export interface CourseDeckInput {
  courseId: number;
  title: string;
}

export interface CourseDeckSummary {
  courseId: number;
  title: string;
  newCount: number;
  learningCount: number;
  dueCount: number;
  totalCount: number;
  masteredCount: number;
  progressPercent: number;
  nextDueLabel: string | null;
}

export interface ReviewResult {
  card: Flashcard;
  rating: ReviewRating;
  intervalDays: number;
  intervalLabel: string;
  intervalLabelUk: string;
  nextDueIso: string;
  previousState: CardState;
  nextState: CardState;
}

export interface BackendReviewPayload {
  card_key: string;
  rating: ReviewRating;
  interval_days: number;
  next_review_at: string;
  card_state: CardState;
  repetitions: number;
  lapses: number;
  ease_factor: number;
  fsrs_state: Record<string, unknown>;
  review_duration_ms?: number;
}

export interface LocalSRSMetrics {
  avgSecondsPerCard: number;
  totalReviewsLogged: number;
  streakDays: number;
  lastReviewDate: string | null;
  reviewDates: string[];
}

export interface SRSEngine {
  getDefaultWeights(): number[];
  getDefaultConfig(): SRSConfig;
  normalizeConfig(raw?: Partial<SRSConfig> | Record<string, unknown> | null): SRSConfig;
  calibrateGoalAndTime(params: {
    targetRetention?: number;
    dailyMinutes?: number;
    avgSecondsPerCard?: number;
    dueReviewCount?: number;
  }): AdaptiveCalibration;
  createCard(input: {
    id: string;
    front: string;
    back: string;
    courseId?: number;
    courseTitle?: string;
    topicIndex?: number;
    topicTitle?: string;
    sourceCitation?: string | null;
    isLearned?: boolean;
    isCustom?: boolean;
    now?: Date;
  }): Flashcard;
  fromBackendCard(raw: Record<string, unknown>): Flashcard;
  getSchedulingPreview(
    card: Flashcard | Record<string, unknown>,
    config?: Partial<SRSConfig> | null,
    now?: Date
  ): SchedulingPreview;
  reviewCard(
    card: Flashcard | Record<string, unknown>,
    rating: ReviewRating,
    config?: Partial<SRSConfig> | null,
    now?: Date
  ): ReviewResult;
  toBackendReviewPayload(result: ReviewResult, reviewDurationMs?: number): BackendReviewPayload;
  computeCourseDecks(
    cards: Array<Flashcard | Record<string, unknown>>,
    courses: Array<CourseDeckInput | Record<string, unknown>>,
    now?: Date
  ): CourseDeckSummary[];
  buildStudyQueue(
    cards: Array<Flashcard | Record<string, unknown>>,
    config?: Partial<SRSConfig> | null,
    options?: { courseId?: number | null; practiceAll?: boolean; now?: Date }
  ): Flashcard[];
  formatInterval(intervalDays: number): string;
  formatIntervalUk(intervalDays: number): string;
  loadLocalConfig(ownerId?: string): Partial<SRSConfig> | null;
  saveLocalConfig(ownerId: string, config: Partial<SRSConfig>): void;
  loadLocalMetrics(ownerId?: string): LocalSRSMetrics;
  recordLocalReviewMetric(ownerId: string, durationMs?: number, now?: Date): LocalSRSMetrics;
}

// ============================================================================
// Internal FSRS <-> Domain Mapping (100% isolated inside srsEngine.ts)
// ============================================================================

const RATING_TO_FSRS: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STATE_FROM_FSRS: Record<State, CardState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const STATE_TO_FSRS: Record<CardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const STORAGE_PREFIX = 'hustle-srs-engine-v1';

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseDateSafe(value: unknown, fallback?: Date): Date | undefined {
  if (!value) return fallback;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function normalizeSteps(raw: unknown, fallback: number[]): number[] {
  if (Array.isArray(raw)) {
    const nums = raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0 && n <= 1440);
    if (nums.length) return nums.slice(0, 5);
  } else if (typeof raw === 'string') {
    const nums = raw
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 1440);
    if (nums.length) return nums.slice(0, 5);
  }
  return [...fallback];
}

function toStepUnits(minutesList: number[]): StepUnit[] {
  return minutesList.map((m) => `${Math.max(1, Math.round(m))}m` as StepUnit);
}

function normalizeWeights(raw: unknown): number[] {
  if (Array.isArray(raw) && raw.length >= 17) {
    const nums = raw.map((v) => Number(v));
    if (nums.every((n) => Number.isFinite(n))) return nums;
  } else if (typeof raw === 'string' && raw.trim()) {
    const nums = raw
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (nums.length >= 17) return nums;
  }
  return [...default_w];
}

function buildFsrsInstance(config: SRSConfig): FSRS {
  const retention = clamp(config.targetRetention, 0.8, 0.98);
  const maxInterval = Math.round(clamp(config.maximumInterval, 1, default_maximum_interval));
  const learningSteps = toStepUnits(config.learningSteps.length ? config.learningSteps : [1, 10]);
  const relearningSteps = toStepUnits(config.relearningSteps.length ? config.relearningSteps : [10]);
  const weights = normalizeWeights(config.weights);

  const params: FSRSParameters = generatorParameters({
    request_retention: retention,
    maximum_interval: maxInterval,
    w: weights,
    enable_fuzz: Boolean(config.enableFuzz),
    enable_short_term: true,
    learning_steps: learningSteps,
    relearning_steps: relearningSteps,
  });

  return fsrs(params);
}

function toFsrsCard(card: Flashcard, now: Date): Card {
  const ed = (card.engineData || {}) as Record<string, unknown>;
  const empty = createEmptyCard(now);

  const state = STATE_TO_FSRS[card.state] ?? State.New;
  const due = parseDateSafe(ed.due ?? card.due, now) ?? now;
  const lastReview = parseDateSafe(ed.last_review ?? card.lastReview, undefined);

  const stability = Number.isFinite(Number(ed.stability ?? card.stability))
    ? Math.max(0, Number(ed.stability ?? card.stability))
    : empty.stability;
  const difficulty = Number.isFinite(Number(ed.difficulty ?? card.difficulty))
    ? clamp(Number(ed.difficulty ?? card.difficulty), 0, 10)
    : empty.difficulty;
  const scheduledDays = Number.isFinite(Number(ed.scheduled_days ?? card.scheduledDays))
    ? Math.max(0, Number(ed.scheduled_days ?? card.scheduledDays))
    : 0;
  const learningSteps = Number.isFinite(Number(ed.learning_steps ?? card.learningSteps))
    ? Math.max(0, Math.round(Number(ed.learning_steps ?? card.learningSteps)))
    : 0;
  const reps = Number.isFinite(Number(ed.reps ?? card.reps))
    ? Math.max(0, Math.round(Number(ed.reps ?? card.reps)))
    : 0;
  const lapses = Number.isFinite(Number(ed.lapses ?? card.lapses))
    ? Math.max(0, Math.round(Number(ed.lapses ?? card.lapses)))
    : 0;

  return {
    due,
    stability,
    difficulty,
    scheduled_days: scheduledDays,
    learning_steps: learningSteps,
    reps,
    lapses,
    state,
    last_review: lastReview,
  };
}

function serializeEngineData(fsrsCard: Card): Record<string, unknown> {
  return {
    due: fsrsCard.due.toISOString(),
    stability: Number(fsrsCard.stability.toFixed(4)),
    difficulty: Number(fsrsCard.difficulty.toFixed(4)),
    scheduled_days: Number(fsrsCard.scheduled_days),
    learning_steps: Number(fsrsCard.learning_steps),
    reps: Number(fsrsCard.reps),
    lapses: Number(fsrsCard.lapses),
    state: STATE_FROM_FSRS[fsrsCard.state] ?? 'new',
    last_review: fsrsCard.last_review ? fsrsCard.last_review.toISOString() : null,
  };
}

function intervalDaysBetween(now: Date, due: Date, scheduledDays: number): number {
  const diffDays = (due.getTime() - now.getTime()) / 86_400_000;
  if (scheduledDays >= 1) return Math.max(scheduledDays, diffDays);
  return Math.max(1 / 1440, diffDays);
}

function formatInterval(intervalDays: number): string {
  const minutes = (Number(intervalDays) || 0) * 1440;
  if (minutes < 1) return '< 1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(Number(intervalDays) || 1);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))}mo`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, '');
  return `${years}y`;
}

function formatIntervalUk(intervalDays: number): string {
  const minutes = (Number(intervalDays) || 0) * 1440;
  if (minutes < 1) return '< 1 хв';
  if (minutes < 60) return `${Math.round(minutes)} хв`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} год`;
  const days = Math.round(Number(intervalDays) || 1);
  if (days < 30) return `${days} д`;
  if (days < 365) return `${Math.max(1, Math.round(days / 30))} міс`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, '');
  return `${years} р`;
}

function normalizeRetention(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return default_request_retention;
  const ratio = num > 1 ? num / 100 : num;
  return Number(clamp(ratio, 0.8, 0.98).toFixed(2));
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function calculateStreak(dates: string[], now: Date): number {
  if (!dates.length) return 0;
  const unique = new Set(dates);
  const today = localDayKey(now);
  const yesterdayDate = new Date(now.getTime() - 86_400_000);
  const yesterday = localDayKey(yesterdayDate);

  let cursor: Date | null = null;
  if (unique.has(today)) cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (unique.has(yesterday)) cursor = new Date(yesterdayDate.getFullYear(), yesterdayDate.getMonth(), yesterdayDate.getDate());
  else return 0;

  let streak = 0;
  while (cursor && unique.has(localDayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return streak;
}

function safeStorageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or private mode restrictions
  }
}

function inferCardState(raw: Record<string, unknown>): CardState {
  const rawState = String(raw.card_state ?? raw.state ?? '').toLowerCase();
  if (rawState === 'new' || rawState === 'learning' || rawState === 'review' || rawState === 'relearning') {
    return rawState;
  }
  const fsrsRaw = raw.fsrs_state as Record<string, unknown> | undefined;
  const fsrsStateStr = String(fsrsRaw?.state ?? '').toLowerCase();
  if (fsrsStateStr === 'new' || fsrsStateStr === 'learning' || fsrsStateStr === 'review' || fsrsStateStr === 'relearning') {
    return fsrsStateStr;
  }
  const reps = Number(raw.repetitions ?? raw.reps ?? 0);
  const lapses = Number(raw.lapses ?? 0);
  const interval = Number(raw.interval_days ?? raw.scheduledDays ?? 0);
  if (reps <= 0 && !raw.last_reviewed_at && !raw.lastReview) return 'new';
  if (interval >= 1) return 'review';
  return lapses > 0 && reps === 0 ? 'relearning' : 'learning';
}

function normalizeFlashcard(input: Flashcard | Record<string, unknown>): Flashcard {
  if ('id' in input && 'state' in input && typeof input.front === 'string' && 'scheduledDays' in input) {
    return input as Flashcard;
  }
  const raw = input as Record<string, unknown>;
  let fsrsState: Record<string, unknown> | null = null;
  if (typeof raw.fsrs_state === 'string' && raw.fsrs_state.trim()) {
    try {
      fsrsState = JSON.parse(raw.fsrs_state) as Record<string, unknown>;
    } catch {
      fsrsState = null;
    }
  } else if (raw.fsrs_state && typeof raw.fsrs_state === 'object') {
    fsrsState = raw.fsrs_state as Record<string, unknown>;
  } else if (raw.engineData && typeof raw.engineData === 'object') {
    fsrsState = raw.engineData as Record<string, unknown>;
  }

  const state = inferCardState({ ...raw, fsrs_state: fsrsState });
  const reps = Number(fsrsState?.reps ?? raw.repetitions ?? raw.reps ?? 0) || 0;
  const lapses = Number(fsrsState?.lapses ?? raw.lapses ?? 0) || 0;
  const scheduledDays = Number(fsrsState?.scheduled_days ?? raw.interval_days ?? raw.scheduledDays ?? 0) || 0;
  const stability = Number(fsrsState?.stability ?? raw.stability ?? Math.max(0, scheduledDays)) || 0;
  const ease = Number(raw.ease_factor ?? 2.5) || 2.5;
  const derivedDifficulty = clamp(10 - (ease - 1.3) * 3.5, 1, 10);
  const difficulty = Number(fsrsState?.difficulty ?? raw.difficulty ?? (reps > 0 ? derivedDifficulty : 0)) || 0;
  const learningSteps = Number(fsrsState?.learning_steps ?? raw.learningSteps ?? 0) || 0;
  const due = (fsrsState?.due ?? raw.next_review_at ?? raw.due ?? null) as string | null;
  const lastReview = (fsrsState?.last_review ?? raw.last_reviewed_at ?? raw.lastReview ?? null) as string | null;

  return {
    id: String(raw.card_key ?? raw.id ?? ''),
    courseId: Number(raw.course_id ?? raw.courseId ?? 0),
    courseTitle: String(raw.course_title ?? raw.courseTitle ?? 'Власні визначення'),
    topicIndex: Number(raw.topic_index ?? raw.topicIndex ?? 0),
    topicTitle: String(raw.topic_title ?? raw.topicTitle ?? ''),
    front: String(raw.front ?? ''),
    back: String(raw.back ?? ''),
    sourceCitation: (raw.source_citation ?? raw.sourceCitation ?? null) as string | null,
    state,
    due,
    stability,
    difficulty,
    scheduledDays,
    learningSteps,
    reps,
    lapses,
    lastReview,
    isLearned: Boolean(raw.is_learned ?? raw.isLearned),
    isCustom: Boolean(raw.is_custom ?? raw.isCustom),
    engineData: fsrsState,
  };
}

// ============================================================================
// Unified Domain Service Implementation
// ============================================================================

export const srsEngine: SRSEngine = {
  getDefaultWeights(): number[] {
    return [...default_w];
  },

  getDefaultConfig(): SRSConfig {
    const base: SRSConfig = {
      targetRetention: default_request_retention,
      dailyMinutes: 20,
      avgSecondsPerCard: 18,
      newCardsLimit: 15,
      dailyReviewLimit: 100,
      learningSteps: [1, 10],
      relearningSteps: [10],
      maximumInterval: 365,
      enableFuzz: false,
      weights: [...default_w],
      includeLearned: true,
      includeNew: true,
      courseIds: [],
    };
    const cal = this.calibrateGoalAndTime({
      targetRetention: base.targetRetention,
      dailyMinutes: base.dailyMinutes,
      avgSecondsPerCard: base.avgSecondsPerCard,
    });
    base.newCardsLimit = cal.newCardsLimit;
    return base;
  },

  normalizeConfig(raw?: Partial<SRSConfig> | Record<string, unknown> | null): SRSConfig {
    const defaults = this.getDefaultConfig();
    if (!raw || typeof raw !== 'object') return defaults;
    const obj = raw as Record<string, unknown>;

    const targetRetention = normalizeRetention(obj.targetRetention ?? obj.target_retention ?? defaults.targetRetention);
    const dailyMinutes = Math.round(clamp(Number(obj.dailyMinutes ?? obj.daily_minutes ?? defaults.dailyMinutes), 5, 240));
    const avgSecondsPerCard = Number(
      clamp(Number(obj.avgSecondsPerCard ?? obj.avg_seconds_per_card ?? defaults.avgSecondsPerCard), 5, 120).toFixed(1)
    );

    const calibrated = this.calibrateGoalAndTime({
      targetRetention,
      dailyMinutes,
      avgSecondsPerCard,
    });

    const explicitNewLimit = obj.newCardsLimit ?? obj.new_cards_limit;
    const newCardsLimit =
      explicitNewLimit !== undefined && explicitNewLimit !== null && Number.isFinite(Number(explicitNewLimit))
        ? Math.round(clamp(Number(explicitNewLimit), 0, 100))
        : calibrated.newCardsLimit;

    const dailyReviewLimit = Math.round(
      clamp(Number(obj.dailyReviewLimit ?? obj.daily_limit ?? defaults.dailyReviewLimit), 1, 500)
    );
    const maximumInterval = Math.round(
      clamp(Number(obj.maximumInterval ?? obj.maximum_interval ?? defaults.maximumInterval), 1, default_maximum_interval)
    );
    const learningSteps = normalizeSteps(obj.learningSteps ?? obj.learning_steps, defaults.learningSteps);
    const relearningSteps = normalizeSteps(obj.relearningSteps ?? obj.relearning_steps, defaults.relearningSteps);
    const weights = normalizeWeights(obj.weights ?? obj.fsrs_weights);
    const courseIdsRaw = obj.courseIds ?? obj.course_ids;
    const courseIds = Array.isArray(courseIdsRaw)
      ? Array.from(new Set(courseIdsRaw.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)))
      : [];

    return {
      targetRetention,
      dailyMinutes,
      avgSecondsPerCard,
      newCardsLimit,
      dailyReviewLimit,
      learningSteps,
      relearningSteps,
      maximumInterval,
      enableFuzz: Boolean(obj.enableFuzz ?? obj.enable_fuzz ?? defaults.enableFuzz),
      weights,
      includeLearned: (obj.includeLearned ?? obj.include_learned) !== false,
      includeNew: (obj.includeNew ?? obj.include_new) !== false,
      courseIds,
    };
  },

  calibrateGoalAndTime({
    targetRetention = default_request_retention,
    dailyMinutes = 20,
    avgSecondsPerCard = 18,
    dueReviewCount = 0,
  }): AdaptiveCalibration {
    const retention = normalizeRetention(targetRetention);
    const minutes = clamp(Number(dailyMinutes) || 20, 5, 240);
    const secPerCard = clamp(Number(avgSecondsPerCard) || 18, 5, 120);

    const totalCapacity = Math.max(1, Math.floor((minutes * 60) / secPerCard));
    // Higher retention requires more frequent reviews (~1.0x at 85% up to ~1.5x at 98%)
    const retentionOverhead = 1 + Math.max(0, retention - 0.85) * 3.2;
    // If existing due review cards aren't specified, reserve ~55% of budget for ongoing reviews
    const reservedReviews =
      dueReviewCount > 0 ? Math.min(totalCapacity * 0.75, dueReviewCount) : totalCapacity * 0.55;
    const remainingBudgetForNew = Math.max(0, totalCapacity - reservedReviews);
    // Each new card typically goes through ~2.2 learning touches on day 1
    const rawNewLimit = Math.floor(remainingBudgetForNew / (2.2 * retentionOverhead));
    const newCardsLimit = Math.round(clamp(rawNewLimit, 1, 80));

    const estimatedNewCardMinutes = Number(((newCardsLimit * 2.2 * secPerCard) / 60).toFixed(1));
    const estimatedReviewMinutes = Number(Math.max(0, minutes - estimatedNewCardMinutes).toFixed(1));

    return {
      targetRetention: retention,
      requestRetention: retention,
      dailyMinutes: Math.round(minutes),
      avgSecondsPerCard: Number(secPerCard.toFixed(1)),
      newCardsLimit,
      estimatedNewCardMinutes,
      estimatedReviewMinutes,
      totalDailyCapacity: totalCapacity,
      explanation: `За ${Math.round(minutes)} хв/день (~${Math.round(secPerCard)} с/картка) і цілі ${Math.round(
        retention * 100
      )}% оптимально вивчати до ${newCardsLimit} нових карток на день (місткість ~${totalCapacity} переглядів).`,
    };
  },

  createCard(input): Flashcard {
    const now = input.now || new Date();
    const empty = createEmptyCard(now);
    const state: CardState = input.isLearned ? 'review' : 'new';
    return {
      id: input.id,
      courseId: Number(input.courseId || 0),
      courseTitle: input.courseTitle || 'Власні визначення',
      topicIndex: Number(input.topicIndex || 0),
      topicTitle: input.topicTitle || '',
      front: input.front,
      back: input.back,
      sourceCitation: input.sourceCitation ?? null,
      state,
      due: now.toISOString(),
      stability: input.isLearned ? 1.0 : empty.stability,
      difficulty: input.isLearned ? 5.0 : empty.difficulty,
      scheduledDays: input.isLearned ? 1 : 0,
      learningSteps: 0,
      reps: input.isLearned ? 1 : 0,
      lapses: 0,
      lastReview: null,
      isLearned: Boolean(input.isLearned),
      isCustom: Boolean(input.isCustom),
      engineData: serializeEngineData({
        ...empty,
        state: input.isLearned ? State.Review : State.New,
        stability: input.isLearned ? 1.0 : empty.stability,
        difficulty: input.isLearned ? 5.0 : empty.difficulty,
        scheduled_days: input.isLearned ? 1 : 0,
        reps: input.isLearned ? 1 : 0,
      }),
    };
  },

  fromBackendCard(raw): Flashcard {
    return normalizeFlashcard(raw);
  },

  getSchedulingPreview(rawCard, rawConfig = null, now = new Date()): SchedulingPreview {
    const config = this.normalizeConfig(rawConfig);
    const card = normalizeFlashcard(rawCard);
    const scheduler = buildFsrsInstance(config);
    const fsrsCard = toFsrsCard(card, now);
    const recordLog = scheduler.repeat(fsrsCard, now);

    const buildOption = (rating: ReviewRating): SchedulingOption => {
      const item = recordLog[RATING_TO_FSRS[rating]];
      const days = intervalDaysBetween(now, item.card.due, item.card.scheduled_days);
      return {
        rating,
        intervalDays: Number(days.toFixed(5)),
        intervalLabel: formatInterval(days),
        intervalLabelUk: formatIntervalUk(days),
        nextDueIso: item.card.due.toISOString(),
        nextState: STATE_FROM_FSRS[item.card.state] ?? 'learning',
      };
    };

    return {
      again: buildOption('again'),
      hard: buildOption('hard'),
      good: buildOption('good'),
      easy: buildOption('easy'),
    };
  },

  reviewCard(rawCard, rating, rawConfig = null, now = new Date()): ReviewResult {
    const config = this.normalizeConfig(rawConfig);
    const card = normalizeFlashcard(rawCard);
    const scheduler = buildFsrsInstance(config);
    const fsrsCard = toFsrsCard(card, now);
    const item = scheduler.next(fsrsCard, now, RATING_TO_FSRS[rating]);

    const nextState = STATE_FROM_FSRS[item.card.state] ?? 'learning';
    const intervalDays = Number(intervalDaysBetween(now, item.card.due, item.card.scheduled_days).toFixed(5));
    const nextDueIso = item.card.due.toISOString();
    const serialized = serializeEngineData(item.card);

    const updated: Flashcard = {
      ...card,
      state: nextState,
      due: nextDueIso,
      stability: Number(item.card.stability.toFixed(4)),
      difficulty: Number(item.card.difficulty.toFixed(4)),
      scheduledDays: Number(item.card.scheduled_days),
      learningSteps: Number(item.card.learning_steps),
      reps: Number(item.card.reps),
      lapses: Number(item.card.lapses),
      lastReview: now.toISOString(),
      isLearned: card.isLearned || rating === 'good' || rating === 'easy' || nextState === 'review',
      engineData: serialized,
    };

    return {
      card: updated,
      rating,
      intervalDays,
      intervalLabel: formatInterval(intervalDays),
      intervalLabelUk: formatIntervalUk(intervalDays),
      nextDueIso,
      previousState: card.state,
      nextState,
    };
  },

  toBackendReviewPayload(result, reviewDurationMs): BackendReviewPayload {
    // Map FSRS difficulty (1..10) to legacy ease_factor range (1.3..3.0) for backward compatibility
    const easeFactor = Number(clamp(3.0 - (result.card.difficulty - 1) * 0.18, 1.3, 3.0).toFixed(2));
    return {
      card_key: result.card.id,
      rating: result.rating,
      interval_days: result.intervalDays,
      next_review_at: result.nextDueIso,
      card_state: result.nextState,
      repetitions: result.card.reps,
      lapses: result.card.lapses,
      ease_factor: easeFactor,
      fsrs_state: result.card.engineData || {},
      ...(reviewDurationMs && reviewDurationMs > 0 ? { review_duration_ms: Math.round(reviewDurationMs) } : {}),
    };
  },

  computeCourseDecks(rawCards, rawCourses, now = new Date()): CourseDeckSummary[] {
    const cards = rawCards.map((c) => normalizeFlashcard(c));
    const byCourse = new Map<number, Flashcard[]>();
    const titleByCourse = new Map<number, string>();

    for (const c of rawCourses) {
      const rec = c as Record<string, unknown>;
      const cid = Number(rec.courseId ?? rec.course_id ?? 0);
      const title = String(rec.title ?? rec.course_title ?? `Курс #${cid}`);
      titleByCourse.set(cid, title);
      if (!byCourse.has(cid)) byCourse.set(cid, []);
    }

    for (const card of cards) {
      if (!byCourse.has(card.courseId)) {
        byCourse.set(card.courseId, []);
        titleByCourse.set(card.courseId, card.courseTitle || (card.courseId === 0 ? 'Власні визначення' : `Курс #${card.courseId}`));
      }
      byCourse.get(card.courseId)!.push(card);
    }

    const nowMs = now.getTime();
    const summaries: CourseDeckSummary[] = [];

    for (const [courseId, list] of byCourse.entries()) {
      let newCount = 0;
      let learningCount = 0;
      let dueCount = 0;
      let masteredCount = 0;
      let earliestFutureMs = Infinity;

      for (const card of list) {
        const dueDate = parseDateSafe(card.due);
        const isDue = !dueDate || dueDate.getTime() <= nowMs;

        if (card.state === 'new') {
          newCount += 1;
        } else if (card.state === 'learning' || card.state === 'relearning') {
          learningCount += 1;
          if (!isDue && dueDate) earliestFutureMs = Math.min(earliestFutureMs, dueDate.getTime());
        } else if (card.state === 'review') {
          if (card.scheduledDays >= 1 || card.reps >= 1) masteredCount += 1;
          if (isDue) dueCount += 1;
          else if (dueDate) earliestFutureMs = Math.min(earliestFutureMs, dueDate.getTime());
        }
      }

      const totalCount = list.length;
      const progressPercent = totalCount > 0 ? Math.round((masteredCount / totalCount) * 100) : 0;
      const nextDueLabel =
        Number.isFinite(earliestFutureMs) && earliestFutureMs > nowMs
          ? formatIntervalUk(Math.max(1 / 1440, (earliestFutureMs - nowMs) / 86_400_000))
          : null;

      summaries.push({
        courseId,
        title: titleByCourse.get(courseId) || `Курс #${courseId}`,
        newCount,
        learningCount,
        dueCount,
        totalCount,
        masteredCount,
        progressPercent,
        nextDueLabel,
      });
    }

    return summaries.sort((a, b) => b.dueCount + b.learningCount + b.newCount - (a.dueCount + a.learningCount + a.newCount));
  },

  buildStudyQueue(rawCards, rawConfig = null, options = {}): Flashcard[] {
    const config = this.normalizeConfig(rawConfig);
    const now = options.now || new Date();
    const nowMs = now.getTime();
    const targetCourseId = options.courseId !== undefined && options.courseId !== null ? Number(options.courseId) : null;
    const practiceAll = Boolean(options.practiceAll);

    let pool = rawCards.map((c) => normalizeFlashcard(c));
    if (targetCourseId !== null && !Number.isNaN(targetCourseId)) {
      pool = pool.filter((c) => c.courseId === targetCourseId);
    } else if (config.courseIds.length > 0) {
      const allowed = new Set(config.courseIds);
      pool = pool.filter((c) => allowed.has(c.courseId) || (c.isCustom && c.courseId === 0));
    }

    pool = pool.filter((c) => (c.isLearned ? config.includeLearned : config.includeNew));

    const learningQueue: Flashcard[] = [];
    const reviewQueue: Flashcard[] = [];
    const newQueue: Flashcard[] = [];

    for (const card of pool) {
      const dueDate = parseDateSafe(card.due);
      const isDue = !dueDate || dueDate.getTime() <= nowMs;
      if (card.state === 'new') {
        newQueue.push(card);
      } else if (card.state === 'learning' || card.state === 'relearning') {
        if (isDue || practiceAll) learningQueue.push(card);
      } else if (isDue || practiceAll) {
        reviewQueue.push(card);
      }
    }

    const byDue = (a: Flashcard, b: Flashcard) => {
      const da = parseDateSafe(a.due)?.getTime() ?? 0;
      const db = parseDateSafe(b.due)?.getTime() ?? 0;
      return da - db;
    };
    learningQueue.sort(byDue);
    reviewQueue.sort(byDue);

    const cappedNew = practiceAll ? newQueue : newQueue.slice(0, config.newCardsLimit);
    const combined = [...learningQueue, ...reviewQueue, ...cappedNew];
    return combined.slice(0, config.dailyReviewLimit);
  },

  formatInterval,
  formatIntervalUk,

  loadLocalConfig(ownerId = 'guest'): Partial<SRSConfig> | null {
    const raw = safeStorageGet(`${STORAGE_PREFIX}:config:${ownerId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Partial<SRSConfig>;
    } catch {
      return null;
    }
  },

  saveLocalConfig(ownerId: string, config: Partial<SRSConfig>): void {
    const merged = this.normalizeConfig(config);
    safeStorageSet(`${STORAGE_PREFIX}:config:${ownerId || 'guest'}`, JSON.stringify(merged));
  },

  loadLocalMetrics(ownerId = 'guest'): LocalSRSMetrics {
    const raw = safeStorageGet(`${STORAGE_PREFIX}:metrics:${ownerId}`);
    const fallback: LocalSRSMetrics = {
      avgSecondsPerCard: 18,
      totalReviewsLogged: 0,
      streakDays: 0,
      lastReviewDate: null,
      reviewDates: [],
    };
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Partial<LocalSRSMetrics>;
      const dates = Array.isArray(parsed.reviewDates) ? parsed.reviewDates.map(String) : [];
      return {
        avgSecondsPerCard: Number(clamp(Number(parsed.avgSecondsPerCard || 18), 5, 120).toFixed(1)),
        totalReviewsLogged: Number(parsed.totalReviewsLogged || 0),
        streakDays: calculateStreak(dates, new Date()),
        lastReviewDate: parsed.lastReviewDate ? String(parsed.lastReviewDate) : null,
        reviewDates: dates.slice(-90),
      };
    } catch {
      return fallback;
    }
  },

  recordLocalReviewMetric(ownerId = 'guest', durationMs = 18000, now = new Date()): LocalSRSMetrics {
    const current = this.loadLocalMetrics(ownerId);
    const today = localDayKey(now);
    const dates = current.reviewDates.includes(today) ? [...current.reviewDates] : [...current.reviewDates, today].slice(-90);
    const sampleSec = clamp((Number(durationMs) || 18000) / 1000, 3, 120);
    const count = current.totalReviewsLogged;
    const nextAvg = count > 0 ? (current.avgSecondsPerCard * Math.min(count, 25) + sampleSec) / (Math.min(count, 25) + 1) : sampleSec;
    const next: LocalSRSMetrics = {
      avgSecondsPerCard: Number(nextAvg.toFixed(1)),
      totalReviewsLogged: count + 1,
      streakDays: calculateStreak(dates, now),
      lastReviewDate: today,
      reviewDates: dates,
    };
    safeStorageSet(`${STORAGE_PREFIX}:metrics:${ownerId || 'guest'}`, JSON.stringify(next));
    return next;
  },
};

declare global {
  interface Window {
    HustleSRSEngine?: SRSEngine;
  }
}

if (typeof window !== 'undefined') {
  window.HustleSRSEngine = srsEngine;
}
