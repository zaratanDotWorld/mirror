const { expect } = require('chai');
const chai = require('chai');
const chaiAlmost = require('chai-almost');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAlmost());
chai.use(chaiAsPromised);

const { db } = require('../src/core/db');
const { Chores, Hearts, Polls, Admin } = require('../src/core/index');
const { YAY, NAY, DAY, HOUR, MINUTE } = require('../src/constants');
const {
  pointsPerResident,
  inflationFactor,
  bootstrapDuration,
  penaltyDelay,
  choresPollLength,
  choresProposalPollLength,
} = require('../src/config');
const { getMonthStart, getNextMonthStart, getPrevMonthEnd } = require('../src/utils');
const testHelpers = require('./helpers');

describe('Chores', async () => {
  const HOUSE = testHelpers.generateSlackId();
  const RESIDENT1 = testHelpers.generateSlackId();
  const RESIDENT2 = testHelpers.generateSlackId();
  const RESIDENT3 = testHelpers.generateSlackId();
  const RESIDENT4 = testHelpers.generateSlackId();

  let dishes;
  let sweeping;
  let restock;

  let now;
  let soon;
  let tomorrow;
  let challengeEnd;
  let proposalEnd;

  async function setChorePreference (houseId, residentId, targetChoreId, sourceChoreId, preference) {
    const normalizedPref = Chores.normalizeChorePreference({ targetChoreId, sourceChoreId, preference });
    return Chores.setChorePreferences(houseId, [ { residentId, ...normalizedPref } ]);
  }

  beforeEach(async () => {
    await Admin.addHouse(HOUSE);

    now = new Date();
    soon = new Date(now.getTime() + MINUTE);
    tomorrow = new Date(now.getTime() + DAY);
    challengeEnd = new Date(now.getTime() + choresPollLength);
    proposalEnd = new Date(now.getTime() + choresProposalPollLength);
  });

  afterEach(async () => {
    await testHelpers.resetDb();
  });

  describe('managing chores and preferences', async () => {
    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, now);
      await Admin.activateResident(HOUSE, RESIDENT2, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can get existing chores', async () => {
      let chores;

      chores = await Chores.getChore(dishes.id);
      expect(chores.houseId).to.equal(HOUSE);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(3);
    });

    it('can set a chore preference', async () => {
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);

      let preferences;
      preferences = await Chores.getChorePreferences(HOUSE, now);
      expect(preferences[0].preference).to.equal(1);
      expect(preferences[0].alphaChoreId).to.equal(dishes.id);
      expect(preferences[0].betaChoreId).to.equal(sweeping.id);

      await setChorePreference(HOUSE, RESIDENT2, dishes.id, sweeping.id, 1);

      preferences = await Chores.getChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(2);

      preferences = await Chores.getResidentChorePreferences(HOUSE, RESIDENT1, now);
      expect(preferences.length).to.equal(1);
    });

    it('can set multiple chore preferences', async () => {
      const prefs = [
        { residentId: RESIDENT1, alphaChoreId: dishes.id, betaChoreId: sweeping.id, preference: 0.9 },
        { residentId: RESIDENT1, alphaChoreId: sweeping.id, betaChoreId: restock.id, preference: 0.8 },
      ];
      await Chores.setChorePreferences(HOUSE, prefs);

      const preferences = await Chores.getChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(2);
      expect(preferences.find(x => x.alphaChoreId === dishes.id).preference).to.equal(0.9);
      expect(preferences.find(x => x.alphaChoreId === sweeping.id).preference).to.equal(0.8);
    });

    it('can update a chore preference', async () => {
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 0);

      const preferences = await Chores.getChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(1);
      expect(preferences[0].preference).to.equal(0);
    });

    it('can query for active chore preferences', async () => {
      await Admin.activateResident(HOUSE, RESIDENT3, now);

      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 0.0);
      await setChorePreference(HOUSE, RESIDENT2, dishes.id, restock.id, 0.5);
      await setChorePreference(HOUSE, RESIDENT3, sweeping.id, restock.id, 1.0);

      let preferences;
      preferences = await Chores.getActiveChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(3);

      // Remove the third preference
      await Admin.deactivateResident(HOUSE, RESIDENT3);

      preferences = await Chores.getActiveChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(2);

      // Restore the third preference
      await Admin.activateResident(HOUSE, RESIDENT3, now);

      preferences = await Chores.getActiveChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(3);

      // Remove the last two preferences
      await Chores.editChore(restock.id, restock.name, {}, false);

      preferences = await Chores.getActiveChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(1);

      // Restore the last two preferences
      await Chores.addChore(HOUSE, restock.name);

      preferences = await Chores.getActiveChorePreferences(HOUSE, now);
      expect(preferences.length).to.equal(3);
    });
  });

  describe('processing chore preferences', async () => {
    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, now);
      await Admin.activateResident(HOUSE, RESIDENT2, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can normalize a chore preference', async () => {
      let pref;

      pref = Chores.normalizeChorePreference({ targetChoreId: dishes.id, sourceChoreId: sweeping.id, preference: 0.7 });
      expect(pref.alphaChoreId).to.equal(dishes.id);
      expect(pref.betaChoreId).to.equal(sweeping.id);
      expect(pref.preference).to.almost.equal(0.7);

      expect(dishes.id).to.be.lt(sweeping.id);

      pref = Chores.normalizeChorePreference({ targetChoreId: sweeping.id, sourceChoreId: dishes.id, preference: 0.7 });
      expect(pref.alphaChoreId).to.equal(dishes.id);
      expect(pref.betaChoreId).to.equal(sweeping.id);
      expect(pref.preference).to.almost.equal(0.3);

      expect(() => Chores.normalizeChorePreference({ alphaChoreId: sweeping.id, betaChoreId: dishes.id }))
        .to.throw('Invalid chore preference!');

      // If already normalized, no-op
      pref = Chores.normalizeChorePreference({ alphaChoreId: dishes.id, betaChoreId: sweeping.id, preference: 0.7 });
      expect(pref.alphaChoreId).to.equal(dishes.id);
      expect(pref.betaChoreId).to.equal(sweeping.id);
      expect(pref.preference).to.almost.equal(0.7);
    });

    it('can merge two sets of chore preferences', async () => {
      const currentPrefs = [
        { residentId: RESIDENT1, alphaChoreId: dishes.id, betaChoreId: sweeping.id, preference: 1 },
        { residentId: RESIDENT1, alphaChoreId: sweeping.id, betaChoreId: restock.id, preference: 1 },
        { residentId: RESIDENT2, alphaChoreId: dishes.id, betaChoreId: sweeping.id, preference: 1 },
        { residentId: RESIDENT2, alphaChoreId: dishes.id, betaChoreId: restock.id, preference: 1 },
      ];

      const newPrefs = [
        // Same resident & preference, new chore
        { residentId: RESIDENT1, alphaChoreId: dishes.id, betaChoreId: restock.id, preference: 0 },
        // Same resident & chore, new preference
        { residentId: RESIDENT1, alphaChoreId: sweeping.id, betaChoreId: restock.id, preference: 0 },
        // Same resident & chore, new preference
        { residentId: RESIDENT2, alphaChoreId: dishes.id, betaChoreId: sweeping.id, preference: 0 },
        // Same chore, preference, & resident
        { residentId: RESIDENT2, alphaChoreId: dishes.id, betaChoreId: restock.id, preference: 1 },
      ];

      const mergedPrefs = Chores.mergeChorePreferences(currentPrefs, newPrefs);
      const mergedPrefsMap = Chores.toPreferenceMap(mergedPrefs);

      expect(mergedPrefs.length).to.equal(5);
      expect(mergedPrefsMap.get(Chores.toPrefKey(currentPrefs[0])).preference).to.equal(1);
      expect(mergedPrefsMap.get(Chores.toPrefKey(currentPrefs[1])).preference).to.equal(0);
      expect(mergedPrefsMap.get(Chores.toPrefKey(currentPrefs[2])).preference).to.equal(0);
      expect(mergedPrefsMap.get(Chores.toPrefKey(currentPrefs[3])).preference).to.equal(1);
      expect(mergedPrefsMap.get(Chores.toPrefKey(newPrefs[0])).preference).to.equal(0);
      expect(mergedPrefsMap.get(Chores.toPrefKey(newPrefs[1])).preference).to.equal(0);
      expect(mergedPrefsMap.get(Chores.toPrefKey(newPrefs[2])).preference).to.equal(0);
      expect(mergedPrefsMap.get(Chores.toPrefKey(newPrefs[3])).preference).to.equal(1);
    });
  });

  describe('managing chore values and rankings', async () => {
    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, now);
      await Admin.activateResident(HOUSE, RESIDENT2, now);
      await Admin.activateResident(HOUSE, RESIDENT3, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can set and query for chore values in a time range', async () => {
      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 },
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 5 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: now, value: 20 },
      ]);

      const endTime = new Date(now.getTime() + MINUTE);
      const startTime = new Date(now.getTime() - MINUTE);

      const dishesValue = await Chores.getChoreValue(dishes.id, startTime, endTime);
      expect(dishesValue).to.equal(15);

      const sweepingValue = await Chores.getChoreValue(sweeping.id, startTime, endTime);
      expect(sweepingValue).to.equal(20);
    });

    it('can set and query for all current chore values', async () => {
      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 },
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 5 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: now, value: 20 },
      ]);

      const soon = new Date(now.getTime() + HOUR);

      const choreValues = await Chores.getCurrentChoreValues(HOUSE, soon);
      expect(choreValues.find(x => x.id === dishes.id).value).to.equal(15);
      expect(choreValues.find(x => x.id === sweeping.id).value).to.equal(20);
      expect(choreValues.find(x => x.id === restock.id).value).to.equal(0);
    });

    it('can return uniform preferences implicitly', async () => {
      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.3333333333333333);
    });

    it('can use preferences to determine chore values', async () => {
      // Prefer dishes to sweeping, and sweeping to restock
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 1);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.5038945471248252);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.31132043857597014);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.18478501429920438);
    });

    it('can use preferences to determine mild chore values', async () => {
      // Slightly prefer dishes to sweeping, and sweeping to restock
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 0.7);
      await setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 0.7);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.37949915168275505);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.3721885654420433);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.24831228287520143);
    });

    it('can use preferences to determine complex chore values', async () => {
      // Prefer both dishes and restock to sweeping
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await setChorePreference(HOUSE, RESIDENT2, restock.id, sweeping.id, 1);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.43135897930403255);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.13728204139193492);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.43135897930403255);
    });

    it('can handle circular chore values', async () => {
      // A cycle of preferences
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await setChorePreference(HOUSE, RESIDENT1, sweeping.id, restock.id, 1);
      await setChorePreference(HOUSE, RESIDENT1, restock.id, dishes.id, 1);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE, now);

      expect(choreRankings[0].ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings[1].ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings[2].ranking).to.almost.equal(0.3333333333333333);
    });

    it('can calculate the interval since the last chore valuation', async () => {
      const t0 = new Date(3000, 0, 1); // January 1
      const t1 = new Date(3000, 0, 2); // January 2

      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: t0, value: 10 },
        { houseId: HOUSE, choreId: dishes.id, valuedAt: t1, value: 10 },
      ]);

      const t2 = new Date(t1.getTime() + HOUR); // 1 hour
      const intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t2);
      expect(intervalScalar).to.almost.equal(0.0013440860215053765);
    });

    it('can calculate the interval on an hourly basis', async () => {
      const t0 = new Date(3000, 0, 1); // January 1
      const t1 = new Date(t0.getTime() + 30 * MINUTE);
      const t2 = new Date(t0.getTime() + 60 * MINUTE);
      const t3 = new Date(t0.getTime() + 90 * MINUTE);
      const t4 = new Date(t0.getTime() + 120 * MINUTE);

      // Update on the hour
      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: t0, value: 10 },
      ]);

      let intervalScalar;
      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t0);
      expect(intervalScalar).to.equal(0);

      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t1);
      expect(intervalScalar).to.equal(0);

      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t2);
      expect(intervalScalar).to.almost.equal(0.0013440860215053765);

      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t3);
      expect(intervalScalar).to.almost.equal(0.0013440860215053765);

      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t4);
      expect(intervalScalar).to.almost.equal(0.002688172043010753);
    });

    it('can update chore values on an hourly basis', async () => {
      const t0 = new Date(3000, 0, 1); // January 1
      const t1 = new Date(t0.getTime() + 30 * MINUTE);
      // Skip t2 in this test
      const t3 = new Date(t0.getTime() + 90 * MINUTE);
      const t4 = new Date(t0.getTime() + 120 * MINUTE);

      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: t0, value: 10 },
      ]);

      let choreValues;
      choreValues = await Chores.updateChoreValues(HOUSE, t0);
      expect(choreValues.length).to.equal(0);

      choreValues = await Chores.updateChoreValues(HOUSE, t1);
      expect(choreValues.length).to.equal(0);

      // Skip t2, do the update at 30 minutes past the hour
      choreValues = await Chores.updateChoreValues(HOUSE, t3);
      expect(choreValues.length).to.equal(3);
      expect(choreValues[0].metadata.intervalScalar).to.almost.equal(0.0013440860215053765);

      // This update succeeds since the previous update was truncated
      choreValues = await Chores.updateChoreValues(HOUSE, t4);
      expect(choreValues.length).to.equal(3);
      expect(choreValues[0].metadata.intervalScalar).to.almost.equal(0.0013440860215053765);
    });

    it('can update chore values, storing useful metadata', async () => {
      const choreValues = await Chores.updateChoreValues(HOUSE, now);

      expect(choreValues[0].metadata.ranking).to.almost.equal(0.3333333333333333);
      expect(choreValues[0].metadata.residents).to.equal(3);
    });

    it('can do an end-to-end update of chore values', async () => {
      // Prefer dishes to sweeping, and sweeping to restock
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 1);

      const t0 = new Date(3000, 3, 10); // April 10 (30 day month), first update gives 72 hours of value
      const t1 = new Date(t0.getTime() + 48 * HOUR); // 48 hours later

      const intervalScalar1 = await Chores.getChoreValueIntervalScalar(HOUSE, t0);
      const choreValues1 = await Chores.updateChoreValues(HOUSE, t0);
      expect(choreValues1.length).to.equal(3);

      const intervalScalar2 = await Chores.getChoreValueIntervalScalar(HOUSE, t1);
      const choreValues2 = await Chores.updateChoreValues(HOUSE, t1);
      expect(choreValues2.length).to.equal(3);

      expect(intervalScalar1 / 3 * 2).to.almost.equal(intervalScalar2); // 72 hours vs 48 hours
      expect(intervalScalar1 + intervalScalar2).to.almost.equal(1 / 6); // 120 hours = 1/6th of the monthly allocation

      const sumPoints1 = choreValues1.map(cv => cv.value).reduce((sum, val) => sum + val, 0);
      const sumPoints2 = choreValues2.map(cv => cv.value).reduce((sum, val) => sum + val, 0);
      expect(sumPoints1 + sumPoints2).to.almost.equal(pointsPerResident * 3 / 6 * inflationFactor);
    });

    it('can get the current, updated chore values', async () => {
      const t0 = new Date(3000, 3, 10); // April 10 (30 day month), first update gives 72 hours of value
      const t1 = new Date(t0.getTime() + 48 * HOUR); // 48 hours later

      // Calculate the initial 72 hour update
      await Chores.updateChoreValues(HOUSE, t0);

      // Calculate the 48 hour update and return the total value for 120 hours
      const choreValues = await Chores.getUpdatedChoreValues(HOUSE, t1);
      const sumPoints = choreValues.map(cv => cv.value).reduce((sum, val) => sum + val, 0);
      expect(sumPoints).to.almost.equal(pointsPerResident * 3 / 6 * inflationFactor);
    });

    it('can get proposed chore values', async () => {
      // Dishes <- Sweeping <- Restock
      await setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 1);

      let choreRankings;

      const newPrefs = [];
      choreRankings = await Chores.getProposedChoreRankings(HOUSE, newPrefs, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.5038945471248252);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.31132043857597014);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.18478501429920438);

      // Shift priority from dishes to sweeping
      newPrefs.push({ residentId: RESIDENT1, alphaChoreId: dishes.id, betaChoreId: sweeping.id, preference: 0.7 });
      choreRankings = await Chores.getProposedChoreRankings(HOUSE, newPrefs, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.3921602623439877);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.43526893223314683);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.17257080542286504);

      // Shift priority from sweeping to restock
      newPrefs.push({ residentId: RESIDENT2, alphaChoreId: sweeping.id, betaChoreId: restock.id, preference: 0.7 });
      choreRankings = await Chores.getProposedChoreRankings(HOUSE, newPrefs, now);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.37949915168275505);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.3721885654420433);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.24831228287520143);
    });
  });

  describe('claiming chores', async () => {
    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, getPrevMonthEnd(now));
      await Admin.activateResident(HOUSE, RESIDENT2, getPrevMonthEnd(now));
      await Admin.activateResident(HOUSE, RESIDENT3, getPrevMonthEnd(now));
      await Admin.activateResident(HOUSE, RESIDENT4, getPrevMonthEnd(now));

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can claim a chore', async () => {
      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 },
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 5 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: now, value: 20 },
      ]);

      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 20);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, now, 10);

      const choreClaims = await Chores.getChoreClaims(RESIDENT1, now, soon);
      expect(choreClaims.length).to.equal(1);
      expect(choreClaims[0].name).to.equal('dishes');
      expect(choreClaims[0].claimedAt.getTime()).to.equal(now.getTime());
      expect(choreClaims[0].value).to.equal(15);
      expect(choreClaims[0].metadata.timeSpent).to.equal(20);
    });

    it('can get the latest chore claim', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);

      let latestChoreClaim;
      latestChoreClaim = await Chores.getLatestChoreClaim(dishes.id, now);
      expect(latestChoreClaim).to.be.undefined;

      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      latestChoreClaim = await Chores.getLatestChoreClaim(dishes.id, now);
      expect(latestChoreClaim.claimedBy).to.equal(RESIDENT1);

      // Can exclude individual claims from the query
      latestChoreClaim = await Chores.getLatestChoreClaim(dishes.id, now, latestChoreClaim.id);
      expect(latestChoreClaim).to.be.undefined;
    });

    it('cannot claim a chore with a zero value', async () => {
      await expect(Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0))
        .to.be.rejectedWith('Cannot claim a zero-value chore!');
    });

    it('can claim a chore incrementally', async () => {
      // Two separate events
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 5 } ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: soon, value: 20 } ]);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT2, soon, 0);

      expect(choreClaim1.claimedBy).to.equal(RESIDENT1);
      expect(choreClaim1.value).to.equal(15);
      expect(choreClaim2.claimedBy).to.equal(RESIDENT2);
      expect(choreClaim2.value).to.equal(20);
    });

    it('can successfully resolve a claim', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, YAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT2, soon, YAY);

      const [ resolvedClaim ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(resolvedClaim.valid).to.be.true;
      expect(resolvedClaim.value).to.equal(10);
      expect(resolvedClaim.resolvedAt.getTime()).to.equal(challengeEnd.getTime());
    });

    it('can successfully resolve many claims at once', async () => {
      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: now, value: 10 },
        { houseId: HOUSE, choreId: restock.id, valuedAt: soon, value: 10 },
      ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, sweeping.id, RESIDENT1, now, 0);
      const [ choreClaim3 ] = await Chores.claimChore(HOUSE, restock.id, RESIDENT1, soon, 0);

      // First poll passes, second fails
      await Polls.submitVote(choreClaim1.pollId, RESIDENT1, soon, YAY);
      await Polls.submitVote(choreClaim1.pollId, RESIDENT2, soon, YAY);
      await Polls.submitVote(choreClaim2.pollId, RESIDENT1, soon, YAY);
      await Polls.submitVote(choreClaim2.pollId, RESIDENT2, soon, NAY);

      await Chores.resolveChoreClaims(HOUSE, challengeEnd);

      const resolvedClaim1 = await Chores.getChoreClaim(choreClaim1.id);
      expect(resolvedClaim1.valid).to.be.true;
      expect(resolvedClaim1.resolvedAt.getTime()).to.equal(challengeEnd.getTime());

      const resolvedClaim2 = await Chores.getChoreClaim(choreClaim2.id);
      expect(resolvedClaim2.valid).to.be.false;
      expect(resolvedClaim2.resolvedAt.getTime()).to.equal(challengeEnd.getTime());

      // This claim was not resolved as poll is not yet closed
      const resolvedClaim3 = await Chores.getChoreClaim(choreClaim3.id);
      expect(resolvedClaim3.valid).to.be.true;
      expect(resolvedClaim3.resolvedAt).to.equal(null);
    });

    it('cannot resolve a claim before the poll closes ', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await expect(Chores.resolveChoreClaim(choreClaim.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a claim twice', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);

      const [ claimResolution ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(claimResolution).to.be.undefined;
    });

    it('can successfully resolve a small claim with only one upvote', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 9 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, YAY);

      const [ resolvedClaim ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(resolvedClaim.valid).to.be.true;
    });

    it('cannot successfully resolve a large claim without at least two upvotes', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, YAY);

      const [ resolvedClaim ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(resolvedClaim.valid).to.be.false;
    });

    it('cannot successfully resolve a claim without a passing vote', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, YAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT2, soon, YAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT3, soon, NAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT4, soon, NAY);

      const [ resolvedClaim ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(resolvedClaim.valid).to.be.false;
    });

    it('can claim the incremental value if a prior claim is approved', async () => {
      const t0 = new Date();
      const t1 = new Date(t0.getTime() + MINUTE);
      const t2 = new Date(t1.getTime() + HOUR);
      const t3 = new Date(t0.getTime() + choresPollLength);
      const t4 = new Date(t1.getTime() + choresPollLength);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: t0, value: 10 } ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, t0, 0);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: t1, value: 5 } ]);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT2, t1, 0);

      // Both claims pass
      await Polls.submitVote(choreClaim1.pollId, RESIDENT1, t2, YAY);
      await Polls.submitVote(choreClaim1.pollId, RESIDENT2, t2, YAY);
      await Polls.submitVote(choreClaim2.pollId, RESIDENT1, t2, YAY);
      await Polls.submitVote(choreClaim2.pollId, RESIDENT2, t2, YAY);

      const [ resolvedClaim1 ] = await Chores.resolveChoreClaim(choreClaim1.id, t3);
      expect(resolvedClaim1.valid).to.be.true;
      expect(resolvedClaim1.value).to.equal(10);

      const [ resolvedClaim2 ] = await Chores.resolveChoreClaim(choreClaim2.id, t4);
      expect(resolvedClaim2.valid).to.be.true;
      expect(resolvedClaim2.value).to.equal(5);
    });

    it('can claim the entire value if a prior claim is denied', async () => {
      const t0 = new Date();
      const t1 = new Date(t0.getTime() + MINUTE);
      const t2 = new Date(t1.getTime() + HOUR);
      const t3 = new Date(t0.getTime() + choresPollLength);
      const t4 = new Date(t1.getTime() + choresPollLength);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: t0, value: 10 } ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, t0, 0);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: t1, value: 5 } ]);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT2, t1, 0);

      // First claim is rejected
      await Polls.submitVote(choreClaim1.pollId, RESIDENT1, t2, YAY);
      await Polls.submitVote(choreClaim1.pollId, RESIDENT2, t2, NAY);

      // Second claim is approved
      await Polls.submitVote(choreClaim2.pollId, RESIDENT1, t2, YAY);
      await Polls.submitVote(choreClaim2.pollId, RESIDENT2, t2, YAY);

      const [ resolvedClaim1 ] = await Chores.resolveChoreClaim(choreClaim1.id, t3);
      expect(resolvedClaim1.valid).to.be.false;
      expect(resolvedClaim1.value).to.equal(10);

      const [ resolvedClaim2 ] = await Chores.resolveChoreClaim(choreClaim2.id, t4);
      expect(resolvedClaim2.valid).to.be.true;
      expect(resolvedClaim2.value).to.equal(15);
    });

    it('can query a users valid chore claims within a time range', async () => {
      const monthStart = getMonthStart(now);
      const y2k = new Date(3000, 1, 1);

      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: now, value: 20 },
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT1, now, 0);

      let chorePoints;
      // Can get all chore points this month
      chorePoints = await Chores.getAllChorePoints(RESIDENT1, monthStart, now);
      expect(chorePoints).to.equal(30);

      // Can get chore-specific points this month
      chorePoints = await Chores.getChorePoints(RESIDENT1, dishes.id, monthStart, now);
      expect(chorePoints).to.equal(10);

      // But nothing next month
      chorePoints = await Chores.getAllChorePoints(RESIDENT1, y2k, monthStart);
      expect(chorePoints).to.equal(0);
    });

    it('can calculate chore penalties', async () => {
      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 91 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: now, value: 80 },
        { houseId: HOUSE, choreId: restock.id, valuedAt: now, value: 69 },
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, now, 0);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT3, now, 0);

      let penalty;
      const penaltyTime = new Date(getNextMonthStart(now).getTime() + penaltyDelay);
      penalty = await Chores.calculatePenalty(RESIDENT1, penaltyTime);
      expect(penalty).to.equal(0);
      penalty = await Chores.calculatePenalty(RESIDENT2, penaltyTime);
      expect(penalty).to.equal(1);
      penalty = await Chores.calculatePenalty(RESIDENT3, penaltyTime);
      expect(penalty).to.equal(1.5);
    });

    it('can calculate chore penalties, taking into account chore breaks', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb15 = new Date(feb1.getTime() + 14 * DAY);

      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: feb1, value: 60 },
        { houseId: HOUSE, choreId: sweeping.id, valuedAt: feb1, value: 50 },
        { houseId: HOUSE, choreId: restock.id, valuedAt: feb1, value: 40 },
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, feb1, 0);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, feb1, 0);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT3, feb1, 0);

      // Everyone takes half the month off
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, feb15, '');
      await Chores.addChoreBreak(HOUSE, RESIDENT2, feb1, feb15, '');
      await Chores.addChoreBreak(HOUSE, RESIDENT3, feb1, feb15, '');

      let penalty;
      const penaltyTime = new Date(getNextMonthStart(feb1).getTime() + penaltyDelay);
      penalty = await Chores.calculatePenalty(RESIDENT1, penaltyTime);
      expect(penalty).to.equal(-0.5);
      penalty = await Chores.calculatePenalty(RESIDENT2, penaltyTime);
      expect(penalty).to.equal(-0.5);
      penalty = await Chores.calculatePenalty(RESIDENT3, penaltyTime);
      expect(penalty).to.equal(0.5);
    });

    it('can add a penalty at the right time', async () => {
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 50 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      let penaltyHeart;
      const penaltyTime = new Date(getNextMonthStart(now).getTime() + penaltyDelay);
      const beforeTime = new Date(penaltyTime.getTime() - 1);

      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, beforeTime);
      expect(penaltyHeart).to.be.undefined;

      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, penaltyTime);
      expect(penaltyHeart.value).to.equal(-2.5);

      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, penaltyTime);
      expect(penaltyHeart).to.be.undefined;
    });

    it('can add chore penalties in bulk', async () => {
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT2, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT3, now);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 100 } ]);
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: restock.id, valuedAt: now, value: 50 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT2, now, 0);

      const penaltyTime = new Date(getNextMonthStart(now).getTime() + penaltyDelay);

      let penaltyHearts;
      penaltyHearts = await Chores.addChorePenalties(HOUSE, penaltyTime);
      expect(penaltyHearts.length).to.equal(3);
      expect(penaltyHearts[0].value).to.equal(0.5);
      expect(penaltyHearts[1].value).to.equal(-2.5);
      expect(penaltyHearts[2].value).to.equal(-5.0);

      // Bulk penalties is robust to network failures
      await Hearts.initialiseResident(HOUSE, RESIDENT4, now);
      penaltyHearts = await Chores.addChorePenalties(HOUSE, penaltyTime);
      expect(penaltyHearts.length).to.equal(1);
      expect(penaltyHearts[0].value).to.equal(-5.0);
    });

    it('cannot penalize before initialized', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 50 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      let penaltyHeart;
      const penaltyTime = new Date(getNextMonthStart(now).getTime() + penaltyDelay);

      // No penalty before initialized
      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, penaltyTime);
      expect(penaltyHeart).to.be.undefined;

      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, penaltyTime);
      expect(penaltyHeart.value).to.equal(-2.5);
    });

    it('can get resident chore stats', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb15 = new Date(feb1.getTime() + 14 * DAY);
      const mar1 = new Date(feb1.getTime() + 28 * DAY);

      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: feb1, value: 10 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, feb1, 0);

      let choreStats;

      choreStats = await Chores.getChoreStats(RESIDENT1, feb1, feb15);
      expect(choreStats.pointsEarned).to.equal(10);
      expect(choreStats.pointsOwed).to.equal(100);
      expect(choreStats.completionPct).to.equal(0.1);

      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, mar1, '');

      choreStats = await Chores.getChoreStats(RESIDENT1, feb1, feb15);
      expect(choreStats.pointsEarned).to.equal(10);
      expect(choreStats.pointsOwed).to.equal(0);
      expect(choreStats.completionPct).to.equal(1);
    });

    it('can get house chore stats', async () => {
      await Chores.updateChoreValues(HOUSE, now);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Chores.updateChoreValues(HOUSE, tomorrow);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, tomorrow, 0);

      const choreStats = await Chores.getHouseChoreStats(HOUSE, now, tomorrow);
      expect(choreStats.length).to.equal(4);
      expect(choreStats[0].residentId).to.equal(RESIDENT2);
      expect(choreStats[1].residentId).to.equal(RESIDENT1);
    });

    it('can reset all chore points', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb15 = new Date(feb1.getTime() + 14 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const choresStart = new Date(feb1.getTime() + bootstrapDuration);
      const ppc = pointsPerResident * 4 / 3; // Monthly points per chore

      let choreValues;
      let choreStats;

      // Initialise chores
      await Chores.updateChoreValues(HOUSE, choresStart);

      // Claim some chores
      await Chores.updateChoreValues(HOUSE, feb8);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, feb8, 0);

      await Chores.updateChoreValues(HOUSE, feb15);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, feb15, 0);

      // Check values
      choreValues = await Chores.getUpdatedChoreValues(HOUSE, feb15);
      expect(choreValues.find(cv => cv.id === dishes.id).value).to.be.almost(ppc * 0.25, 1e-5);
      expect(choreValues.find(cv => cv.id === sweeping.id).value).to.be.almost(ppc * 0, 1e-5);
      expect(choreValues.find(cv => cv.id === restock.id).value).to.be.almost(ppc * 0.5, 1e-5);

      choreStats = await Chores.getHouseChoreStats(HOUSE, feb1, feb15);
      expect(choreStats.find(cs => cs.residentId === RESIDENT1).pointsEarned).to.be.almost(ppc * 0.25, 1e-5);
      expect(choreStats.find(cs => cs.residentId === RESIDENT2).pointsEarned).to.be.almost(ppc * 0.5, 1e-5);
      expect(choreStats.find(cs => cs.residentId === RESIDENT3).pointsEarned).to.be.almost(ppc * 0, 1e-5);
      expect(choreStats.find(cs => cs.residentId === RESIDENT1).pointsOwed).to.equal(pointsPerResident);
      expect(choreStats.find(cs => cs.residentId === RESIDENT2).pointsOwed).to.equal(pointsPerResident);
      expect(choreStats.find(cs => cs.residentId === RESIDENT3).pointsOwed).to.equal(pointsPerResident);

      // Reset chore points
      await Chores.resetChorePoints(HOUSE, feb15);

      // Check values
      choreValues = await Chores.getUpdatedChoreValues(HOUSE, feb15);
      expect(choreValues.find(cv => cv.id === dishes.id).value).to.equal(0);
      expect(choreValues.find(cv => cv.id === sweeping.id).value).to.equal(0);
      expect(choreValues.find(cv => cv.id === restock.id).value).to.equal(0);

      choreStats = await Chores.getHouseChoreStats(HOUSE, feb1, feb15);
      expect(choreStats.find(cs => cs.residentId === RESIDENT1).pointsEarned).to.equal(0);
      expect(choreStats.find(cs => cs.residentId === RESIDENT2).pointsEarned).to.equal(0);
      expect(choreStats.find(cs => cs.residentId === RESIDENT3).pointsEarned).to.equal(0);
      expect(choreStats.find(cs => cs.residentId === RESIDENT1).pointsOwed).to.equal(pointsPerResident * 0.5);
      expect(choreStats.find(cs => cs.residentId === RESIDENT2).pointsOwed).to.equal(pointsPerResident * 0.5);
      expect(choreStats.find(cs => cs.residentId === RESIDENT3).pointsOwed).to.equal(pointsPerResident * 0.5);

      await Chores.updateChoreValues(HOUSE, feb22);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT3, feb22, 0);

      choreValues = await Chores.getUpdatedChoreValues(HOUSE, feb22);
      expect(choreValues.find(cv => cv.id === dishes.id).value).to.be.almost(ppc * 0.25, 1e-5);
      expect(choreValues.find(cv => cv.id === sweeping.id).value).to.be.almost(ppc * 0.25, 1e-5);
      expect(choreValues.find(cv => cv.id === restock.id).value).to.be.almost(ppc * 0, 1e-5);

      choreStats = await Chores.getHouseChoreStats(HOUSE, feb1, feb22);
      expect(choreStats.find(cs => cs.residentId === RESIDENT3).pointsEarned).to.be.almost(ppc * 0.25, 1e-5);
    });

    it('can check if a house is active using claims', async () => {
      const nextWeek = new Date(now.getTime() + 7 * DAY);

      await db('ChoreValue').insert([
        { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 },
      ]);

      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      let active;
      active = await Admin.houseActive(HOUSE, 'ChoreClaim', 'claimedAt', now, tomorrow);
      expect(active).to.be.true;

      active = await Admin.houseActive(HOUSE, 'ChoreClaim', 'claimedAt', tomorrow, nextWeek);
      expect(active).to.be.false;
    });
  });

  describe('managing chore breaks', async () => {
    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, now);
      await Admin.activateResident(HOUSE, RESIDENT2, now);
    });

    it('can add, query, and delete chore breaks', async () => {
      let choreBreaks;
      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(0);

      const circumstance = 'Visting family';
      const [ choreBreak ] = await Chores.addChoreBreak(HOUSE, RESIDENT1, now, tomorrow, circumstance);

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(1);
      expect(choreBreaks[0].metadata.circumstance).to.equal(circumstance);

      await Chores.deleteChoreBreak(choreBreak.id);

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(0);
    });

    it('can query chore breaks by day', async () => {
      const twoDays = new Date(now.getTime() + 2 * DAY);

      await Chores.addChoreBreak(HOUSE, RESIDENT2, now, tomorrow, '');
      await Chores.addChoreBreak(HOUSE, RESIDENT2, now, twoDays, '');

      let choreBreaks;
      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(2);
      choreBreaks = await Chores.getChoreBreaks(HOUSE, tomorrow);
      expect(choreBreaks.length).to.equal(1);
      choreBreaks = await Chores.getChoreBreaks(HOUSE, twoDays);
      expect(choreBreaks.length).to.equal(0);
    });

    it('can exclude breaks by inactive and exempt users', async () => {
      await Chores.addChoreBreak(HOUSE, RESIDENT1, now, tomorrow, '');

      let choreBreaks;
      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(1);

      await Admin.exemptResident(HOUSE, RESIDENT1, now);

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(0);

      await Admin.unexemptResident(HOUSE, RESIDENT1, now);

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(1);

      await Admin.deactivateResident(HOUSE, RESIDENT1);

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(0);
    });

    it('can exclude on-break residents from the chore valuing', async () => {
      await Admin.activateResident(HOUSE, RESIDENT3, now);
      await Admin.activateResident(HOUSE, RESIDENT4, now);

      const twoDays = new Date(now.getTime() + 2 * DAY);
      const oneWeek = new Date(now.getTime() + 7 * DAY);
      const twoWeeks = new Date(now.getTime() + 14 * DAY);
      const lastMonth = new Date(now.getTime() - 35 * DAY);
      const nextMonth = new Date(now.getTime() + 35 * DAY);
      const twoMonths = new Date(now.getTime() + 60 * DAY);

      let workingResidentCount;
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(4);

      // Will exclude inactive residents
      await Admin.deactivateResident(HOUSE, RESIDENT4);
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(3);

      // Will count active breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, now, twoDays, '');
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(2);

      // Can handle overlapping breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, now, tomorrow, '');
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(2);

      // Can handle new breaks by the same user
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, oneWeek);
      expect(workingResidentCount).to.equal(3);

      await Chores.addChoreBreak(HOUSE, RESIDENT1, oneWeek, twoWeeks, '');
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, oneWeek);
      expect(workingResidentCount).to.equal(2);

      // Will also exclude if break extends across months
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(2);

      await Chores.addChoreBreak(HOUSE, RESIDENT2, lastMonth, nextMonth, '');
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(1);

      // Will not count breaks in the past
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, twoMonths);
      expect(workingResidentCount).to.equal(3);

      // Will not count breaks in the future
      await Chores.addChoreBreak(HOUSE, RESIDENT3, tomorrow, oneWeek, '');
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(1);
    });

    it('can return the percent of the period a resident is not on break', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb15 = new Date(feb1.getTime() + 14 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar1 = new Date(feb1.getTime() + 28 * DAY);
      const mar8 = new Date(mar1.getTime() + 7 * DAY);
      const mar15 = new Date(mar1.getTime() + 14 * DAY);

      let workingPercentage;

      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(1);

      // Take the first week off
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, feb8, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.75);

      // Take the third week off
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb15, feb22, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.5);

      // Take time off next month, has no effect
      await Chores.addChoreBreak(HOUSE, RESIDENT1, mar1, mar15, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.5);

      // Take the first two weeks off, this break overlaps with the first break
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, feb15, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.25);

      // Take the last week off, this break stretches into the next month
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb22, mar8, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.0);

      // Other residents are not affected
      const otherWorkingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT2, feb1);
      expect(otherWorkingPercentage).to.equal(1);
    });

    it('can consider only the parts of breaks in the current month', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar8 = new Date(feb1.getTime() + 35 * DAY);
      const jan25 = new Date(feb1.getTime() - 7 * DAY);

      let workingPercentage;

      // Overlap last and first weeks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, jan25, feb8, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.75);

      // Overlap last and first weeks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb22, mar8, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0.5);
    });

    it('can consider a break which starts before and ends after the current month', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const mar8 = new Date(feb1.getTime() + 35 * DAY);
      const jan25 = new Date(feb1.getTime() - 7 * DAY);

      // Add a six-week break
      await Chores.addChoreBreak(HOUSE, RESIDENT1, jan25, mar8, '');
      const workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb1);
      expect(workingPercentage).to.equal(0);

      // Other residents are not affected
      const otherWorkingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT2, feb1);
      expect(otherWorkingPercentage).to.equal(1);
    });

    it('can consider complex break combinations', async () => {
      const feb15 = new Date(3000, 1, 15);
      const mar1 = new Date(3000, 2, 1);
      const apr1 = new Date(3000, 3, 1); // April, a 30 day month
      const apr7 = new Date(3000, 3, 7);
      const apr10 = new Date(3000, 3, 10);
      const apr22 = new Date(3000, 3, 22);
      const apr25 = new Date(3000, 3, 25);
      const may5 = new Date(3000, 4, 5);

      let workingPercentage;

      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, apr1);
      expect(workingPercentage).to.equal(1);

      // Add a six-week break from feb into april (6 day break)
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb15, apr7, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, feb15);
      expect(workingPercentage).to.equal(0.5);

      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, mar1);
      expect(workingPercentage).to.equal(0);

      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, apr1);
      expect(workingPercentage).to.equal(0.8);

      // Add a week-long break mid-april (12 day break)
      await Chores.addChoreBreak(HOUSE, RESIDENT1, apr10, apr22, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, apr1);
      expect(workingPercentage).to.equal(0.4);

      // Add a two-week break spanning april and may (6 day break)
      await Chores.addChoreBreak(HOUSE, RESIDENT1, apr25, may5, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT1, apr1);
      expect(workingPercentage).to.equal(0.2);
    });

    it('can consider the resident activeAt when calculating working percentage', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar1 = new Date(feb1.getTime() + 28 * DAY);

      let workingPercentage;

      await Admin.activateResident(HOUSE, RESIDENT3, feb8);

      // activeAt used to create implicit break
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT3, feb1);
      expect(workingPercentage).to.equal(0.75);

      // Can combine with regular breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT3, feb22, mar1, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT3, feb1);
      expect(workingPercentage).to.equal(0.5);
    });

    it('can consider the resident exemptAt when calculating active percentage', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar1 = new Date(feb1.getTime() + 28 * DAY);

      let workingPercentage;

      await Admin.activateResident(HOUSE, RESIDENT3, feb1);
      await Admin.exemptResident(HOUSE, RESIDENT3, feb22);

      // exemptAt used to create implicit break
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT3, feb1);
      expect(workingPercentage).to.equal(0.75);

      // Can combine with regular breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT3, feb8, feb22, '');
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT3, feb1);
      expect(workingPercentage).to.equal(0.25);

      // Next month, owes no points
      workingPercentage = await Chores.getWorkingResidentPercentage(RESIDENT3, mar1);
      expect(workingPercentage).to.equal(0);
    });

    it('can correctly count working residents when someone is exempt', async () => {
      const twoDays = new Date(now.getTime() + 2 * DAY);

      let workingResidentCount;
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(2);

      await Chores.addChoreBreak(HOUSE, RESIDENT1, tomorrow, twoDays, '');

      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(2);
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, tomorrow);
      expect(workingResidentCount).to.equal(1);
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, twoDays);
      expect(workingResidentCount).to.equal(2);

      await Admin.exemptResident(HOUSE, RESIDENT1, tomorrow);

      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, now);
      expect(workingResidentCount).to.equal(2);
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, tomorrow);
      expect(workingResidentCount).to.equal(1);
      workingResidentCount = await Chores.getWorkingResidentCount(HOUSE, twoDays);
      expect(workingResidentCount).to.equal(1);
    });
  });

  describe('managing chore point gifts', async () => {
    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, now);
      await Admin.activateResident(HOUSE, RESIDENT2, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can gift chore points', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);

      await Chores.giftChorePoints(HOUSE, RESIDENT1, RESIDENT2, now, 6);

      const monthStart = getMonthStart(now);
      const chorePoints1 = await Chores.getAllChorePoints(RESIDENT1, monthStart, now);
      const chorePoints2 = await Chores.getAllChorePoints(RESIDENT2, monthStart, now);
      expect(chorePoints1).to.equal(4);
      expect(chorePoints2).to.equal(6);
    });

    it('cannot gift more than your current balance', async () => {
      await expect(Chores.giftChorePoints(HOUSE, RESIDENT1, RESIDENT2, now, 10))
        .to.be.rejectedWith('Cannot gift more than the points balance!');
    });

    it('can have a negative balance if a claim is denied after gifting', async () => {
      await db('ChoreValue').insert([ { houseId: HOUSE, choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now, 0);
      await Chores.giftChorePoints(HOUSE, RESIDENT1, RESIDENT2, now, 6);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, NAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT2, soon, NAY);
      await Chores.resolveChoreClaims(HOUSE, challengeEnd);

      const monthStart = getMonthStart(now);
      const chorePoints1 = await Chores.getAllChorePoints(RESIDENT1, monthStart, challengeEnd);
      const chorePoints2 = await Chores.getAllChorePoints(RESIDENT2, monthStart, challengeEnd);
      expect(chorePoints1).to.equal(-6);
      expect(chorePoints2).to.equal(6);
    });
  });

  describe('editing chores', async () => {
    let chores, proposal;

    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT1, now);
      await Admin.activateResident(HOUSE, RESIDENT2, now);

      [ chores, proposal ] = [ undefined, undefined ];
    });

    it('can add a chore', async () => {
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const name = 'cooking';
      const description = 'Rice & beans';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, { description }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);
      expect(chores[0].metadata.description).to.equal(description);
    });

    it('can overwrite an existing chore', async () => {
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const name = 'cooking';
      let description = 'Rice & beans';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, { description }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);
      expect(chores[0].name).to.equal(name);
      expect(chores[0].metadata.description).to.equal(description);

      description = 'Rice & beans with hot sauce';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, { description }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);
      expect(chores[0].name).to.equal(name);
      expect(chores[0].metadata.description).to.equal(description);
    });

    it('can edit a chore', async () => {
      let name = 'laundry';
      let description = 'Wash clothes';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, { description }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      let chore = chores.find(x => x.name === name);
      const initialChoreId = chore.id;
      expect(chore.metadata.description).to.equal(description);

      name = 'laundry2';
      description = 'Wash and dry clothes';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, chore.id, name, { description }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      chore = chores.find(x => x.name === name);
      expect(chore.id).to.equal(initialChoreId);
      expect(chore.metadata.description).to.equal(description);
    });

    it('can delete a chore', async () => {
      const name = 'cleaning';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, {}, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);

      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, chores[0].id, chores[0].name, {}, false, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);
    });

    it('cannot create a proposal without either a choreId or name', async () => {
      await expect(Chores.createChoreProposal(HOUSE, RESIDENT1, undefined, undefined, {}, true, now))
        .to.be.rejectedWith('Proposal must include either choreId or name!');
    });

    it('cannot resolve a proposal before the poll is closed', async () => {
      const name = 'cooking';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, {}, true, now);

      await expect(Chores.resolveChoreProposal(proposal.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a proposal twice', async () => {
      const name = 'cooking';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, {}, true, now);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      await expect(Chores.resolveChoreProposal(proposal.id, proposalEnd))
        .to.be.rejectedWith('Proposal already resolved!');
    });

    it('can get the minimum votes for a proposal', async () => {
      await Admin.activateResident(HOUSE, RESIDENT3, now);
      await Admin.activateResident(HOUSE, RESIDENT4, now);

      let minVotes;

      // 40% of 4 residents is 2 upvotes
      minVotes = await Chores.getChoreProposalMinVotes(HOUSE, now);
      expect(minVotes).to.equal(2);

      // Exempt users are not counted
      await testHelpers.createExemptUsers(HOUSE, 10);
      minVotes = await Chores.getChoreProposalMinVotes(HOUSE, now);
      expect(minVotes).to.equal(2);
    });

    it('cannot approve a proposal with insufficient votes', async () => {
      await Admin.activateResident(HOUSE, RESIDENT3, now);
      await Admin.activateResident(HOUSE, RESIDENT4, now);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const name = 'cooking';
      [ proposal ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, name, {}, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, NAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      // Cannot resolve again
      await Polls.submitVote(proposal.pollId, RESIDENT3, now, YAY);
      await expect(Chores.resolveChoreProposal(proposal.id, proposalEnd))
        .to.be.rejectedWith('Proposal already resolved!');
    });

    it('can resolve proposals in bulk', async () => {
      await Admin.activateResident(HOUSE, RESIDENT3, now); // Avoid auto-closing polls

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const [ proposal1 ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, 'c1', {}, true, now);
      const [ proposal2 ] = await Chores.createChoreProposal(HOUSE, RESIDENT1, null, 'c2', {}, true, now);

      await Polls.submitVote(proposal1.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal1.pollId, RESIDENT2, now, YAY);

      await Polls.submitVote(proposal2.pollId, RESIDENT2, now, YAY);
      await Polls.submitVote(proposal2.pollId, RESIDENT1, now, YAY);

      // Not before the polls close
      await Chores.resolveChoreProposals(HOUSE, soon);
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      // Actually resolve
      await Chores.resolveChoreProposals(HOUSE, proposalEnd);
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(2);

      // But not twice
      await Chores.resolveChoreProposals(HOUSE, proposalEnd);
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(2);
    });
  });
});
