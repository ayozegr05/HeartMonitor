import { fetchGarminApiDays } from '@/features/garmin/garminApi';
import {
    GarminAuthError,
    garminGet,
    loadGarminTokens,
} from '@/features/garmin/garminClient';

jest.mock('@/features/garmin/garminClient', () => ({
  // Stand-in matching the real signature — importing the real module
  // pulls AsyncStorage, which needs a native mock under jest-expo.
  GarminAuthError: class extends Error {
    readonly code: string;
    constructor(message: string, code = 'credentials') {
      super(message);
      this.name = 'GarminAuthError';
      this.code = code;
    }
  },
  garminGet: jest.fn(),
  loadGarminTokens: jest.fn(),
}));

const mockGet = garminGet as jest.MockedFunction<typeof garminGet>;
const mockTokens = loadGarminTokens as jest.MockedFunction<
  typeof loadGarminTokens
>;

const TOKENS = {
  oauth1: { token: 't', secret: 's' },
  oauth2: { access_token: 'a', expiresAt: 9999999999 },
  displayName: 'user1',
  email: 'u@x.com',
};

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

beforeEach(() => {
  jest.resetAllMocks();
  mockTokens.mockResolvedValue(TOKENS);
});

describe('fetchGarminApiDays', () => {
  it('returns null when no account is linked', async () => {
    mockTokens.mockResolvedValue(null);
    expect(await fetchGarminApiDays(7)).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('maps the HRV range response onto per-day points', async () => {
    mockGet.mockImplementation(async (path) => {
      if (path.startsWith('/hrv-service/hrv/daily/')) {
        return {
          hrvSummaries: [
            { calendarDate: today(), lastNightAvg: 42.4, weeklyAvg: 39 },
            { calendarDate: '2020-01-01', lastNightAvg: 30 },
          ],
        };
      }
      return null;
    });
    const days = await fetchGarminApiDays(7);
    expect(days?.get(today())?.hrvRmssdMs).toBe(42);
    expect(days?.get('2020-01-01')?.hrvRmssdMs).toBe(30);
  });

  it('collects sleep detail + per-day vitals for recent days', async () => {
    mockGet.mockImplementation(async (path) => {
      if (path.startsWith('/wellness-service/wellness/daily/spo2/')) {
        return { averageSpO2: 96.2, lowestSpO2: 88 };
      }
      if (path.startsWith('/wellness-service/wellness/daily/respiration/')) {
        return { avgSleepRespirationValue: 14.34 };
      }
      if (path.includes('dailySleepData')) {
        return {
          dailySleepDTO: {
            sleepStartTimestampGMT: 1700000000000,
            sleepEndTimestampGMT: 1700028800000,
            deepSleepSeconds: 3600,
            lightSleepSeconds: 14400,
            remSleepSeconds: 5400,
            awakeSleepSeconds: 600,
            avgOvernightHrv: 51.6,
          },
        };
      }
      return null;
    });
    const days = await fetchGarminApiDays(3);
    const d = days!.get(today())!;
    expect(d.spo2AvgPct).toBeCloseTo(96.2);
    expect(d.spo2MinPct).toBe(88);
    expect(d.respirationPerMin).toBeCloseTo(14.3);
    expect(d.hrvRmssdMs).toBe(52);
    expect(d.sleep?.startedAt).toBe(1700000000000);
    expect(d.sleep?.stagesMs.deep).toBe(3_600_000);
  });

  it('tolerates empty and malformed payloads', async () => {
    mockGet.mockResolvedValue(null);
    const days = await fetchGarminApiDays(3);
    expect(days).not.toBeNull();
    expect(days!.size).toBe(0);
  });

  it('keeps working when one endpoint throws a generic error', async () => {
    mockGet.mockImplementation(async (path) => {
      if (path.startsWith('/hrv-service')) throw new Error('HTTP 500');
      if (path.startsWith('/wellness-service/wellness/daily/spo2/')) {
        return { averageSpO2: 95 };
      }
      return null;
    });
    const days = await fetchGarminApiDays(3);
    expect(days!.get(today())?.spo2AvgPct).toBe(95);
    expect(days!.get(today())?.hrvRmssdMs).toBeUndefined();
  });

  it('propagates auth errors so the UI can flag re-login', async () => {
    mockGet.mockRejectedValue(
      new GarminAuthError('Sesión Garmin caducada', 'reauth'),
    );
    await expect(fetchGarminApiDays(3)).rejects.toThrow(GarminAuthError);
  });
});
