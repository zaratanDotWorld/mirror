const { expect } = require('chai');
const chai = require('chai');
const chaiAlmost = require('chai-almost');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAlmost());
chai.use(chaiAsPromised);

const { Chores, Hearts, Polls, Admin } = require('../src/core/index');
const { YAY, NAY, DAY, HOUR, MINUTE } = require('../src/constants');
const { pointsPerResident, inflationFactor, penaltyDelay, choresPollLength, choresProposalPollLength } = require('../src/config');
const { getMonthStart, getNextMonthStart, getPrevMonthEnd } = require('../src/utils');
const { db } = require('../src/core/db');

describe('Chores', async () => {
  const HOUSE = 'house123';

  const RESIDENT1 = 'RESIDENT1';
  const RESIDENT2 = 'RESIDENT2';
  const RESIDENT3 = 'RESIDENT3';
  const RESIDENT4 = 'RESIDENT4';

  let dishes;
  let sweeping;
  let restock;

  let now;
  let soon;
  let challengeEnd;
  let proposalEnd;

  before(async () => {
    await db('House').del();
    await Admin.updateHouse({ slackId: HOUSE });

    now = new Date();
    soon = new Date(now.getTime() + MINUTE);
    challengeEnd = new Date(now.getTime() + choresPollLength);
    proposalEnd = new Date(now.getTime() + choresProposalPollLength);
  });

  afterEach(async () => {
    await db('ChoreProposal').del();
    await db('ChoreBreak').del();
    await db('ChoreClaim').del();
    await db('ChoreValue').del();
    await db('ChorePref').del();
    await db('PollVote').del();
    await db('Heart').del();
    await db('Chore').del();
    await db('Poll').del();
    await db('Resident').del();
  });

  describe('managing chore preferences', async () => {
    beforeEach(async () => {
      await Admin.addResident(HOUSE, RESIDENT1, now);
      await Admin.addResident(HOUSE, RESIDENT2, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can list the existing chores', async () => {
      const chores = await Chores.getChores(HOUSE);

      expect(chores.length).to.equal(3);
    });

    it('can set and query for chore values in a time range', async () => {
      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 10 },
        { choreId: dishes.id, valuedAt: now, value: 5 },
        { choreId: sweeping.id, valuedAt: now, value: 20 }
      ]);

      const endTime = new Date(now.getTime() + MINUTE);
      const startTime = new Date(now.getTime() - MINUTE);

      const dishesValue = await Chores.getChoreValue(dishes.id, startTime, endTime);
      expect(dishesValue.sum).to.equal(15);

      const sweepingValue = await Chores.getChoreValue(sweeping.id, startTime, endTime);
      expect(sweepingValue.sum).to.equal(20);
    });

    it('can set and query for all current chore values', async () => {
      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 10 },
        { choreId: dishes.id, valuedAt: now, value: 5 },
        { choreId: sweeping.id, valuedAt: now, value: 20 }
      ]);

      const soon = new Date(now.getTime() + HOUR);

      const choreValues = await Chores.getCurrentChoreValues(HOUSE, soon);
      expect(choreValues.find(x => x.id === dishes.id).value).to.equal(15);
      expect(choreValues.find(x => x.id === sweeping.id).value).to.equal(20);
      expect(choreValues.find(x => x.id === restock.id).value).to.equal(0);
    });

    it('can set a chore preference', async () => {
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT2, dishes.id, sweeping.id, 0);

      const preferences = await Chores.getChorePreferences(HOUSE);
      expect(preferences[0].preference).to.equal(1);
      expect(preferences[1].preference).to.equal(0);
    });

    it('can update a chore preference', async () => {
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 0);

      const preferences = await Chores.getChorePreferences(HOUSE);
      expect(preferences.length).to.equal(1);
      expect(preferences[0].preference).to.equal(0);
    });

    it('can query for active chore preferences', async () => {
      await Admin.addResident(HOUSE, RESIDENT3, now);

      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 0.0);
      await Chores.setChorePreference(HOUSE, RESIDENT2, dishes.id, restock.id, 0.5);
      await Chores.setChorePreference(HOUSE, RESIDENT3, sweeping.id, restock.id, 1.0);

      let preferences;
      preferences = await Chores.getActiveChorePreferences(HOUSE);
      expect(preferences.length).to.equal(3);

      // Remove the third preference
      await Admin.deleteResident(HOUSE, RESIDENT3);

      preferences = await Chores.getActiveChorePreferences(HOUSE);
      expect(preferences.length).to.equal(2);

      // Restore the third preference
      await Admin.addResident(HOUSE, RESIDENT3, now);

      preferences = await Chores.getActiveChorePreferences(HOUSE);
      expect(preferences.length).to.equal(3);

      // Remove the last two preferences
      await Chores.deleteChore(HOUSE, restock.name);

      preferences = await Chores.getActiveChorePreferences(HOUSE);
      expect(preferences.length).to.equal(1);

      // Restore the last two preferences
      await Chores.addChore(HOUSE, restock.name);

      preferences = await Chores.getActiveChorePreferences(HOUSE);
      expect(preferences.length).to.equal(3);
    });
  });

  describe('managing chore values', async () => {
    beforeEach(async () => {
      await Admin.addResident(HOUSE, RESIDENT1, now);
      await Admin.addResident(HOUSE, RESIDENT2, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can return uniform preferences implicitly', async () => {
      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE);

      expect(choreRankings[0].ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings[1].ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings[2].ranking).to.almost.equal(0.3333333333333333);
    });

    it('can use preferences to determine chore values', async () => {
      // Prefer dishes to sweeping, and sweeping to restock
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 1);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE);

      expect(choreRankings[0].ranking).to.almost.equal(0.7489979877837285);
      expect(choreRankings[1].ranking).to.almost.equal(0.17833693651364188);
      expect(choreRankings[2].ranking).to.almost.equal(0.07266507570262926);
    });

    it('can use preferences to determine mild chore values', async () => {
      // Slightly prefer dishes to sweeping, and sweeping to restock
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 0.7);
      await Chores.setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 0.7);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE);

      expect(choreRankings[0].ranking).to.almost.equal(0.4351476115449498);
      expect(choreRankings[1].ranking).to.almost.equal(0.4108001133052762);
      expect(choreRankings[2].ranking).to.almost.equal(0.15405227514977385);
    });

    it('can use preferences to determine complex chore values', async () => {
      // Prefer both dishes and restock to sweeping
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 0);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE);

      expect(choreRankings.find(x => x.id === dishes.id).ranking).to.almost.equal(0.4791504809209527);
      expect(choreRankings.find(x => x.id === sweeping.id).ranking).to.almost.equal(0.04169903815809436);
      expect(choreRankings.find(x => x.id === restock.id).ranking).to.almost.equal(0.4791504809209527);
    });

    it('can handle circular chore values', async () => {
      // A cycle of preferences
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT1, sweeping.id, restock.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, restock.id, 0);

      const choreRankings = await Chores.getCurrentChoreRankings(HOUSE);

      expect(choreRankings[0].ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings[1].ranking).to.almost.equal(0.3333333333333333);
      expect(choreRankings[2].ranking).to.almost.equal(0.3333333333333333);
    });

    it('can calculate the interval since the last chore valuation', async () => {
      const t0 = new Date(2000, 0, 1); // January 1
      const t1 = new Date(2000, 0, 2); // January 2

      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: t0, value: 10 },
        { choreId: dishes.id, valuedAt: t1, value: 10 }
      ]);

      const t2 = new Date(t1.getTime() + HOUR); // 1 hour
      const intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t2);
      expect(intervalScalar).to.almost.equal(0.0013440860215053765);
    });

    it('can calculate the interval on an hourly basis', async () => {
      const t0 = new Date(2000, 0, 1);

      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: t0, value: 10 }
      ]);

      const t1 = new Date(t0.getTime() + (HOUR + 10 * MINUTE));
      const t2 = new Date(t0.getTime() + (HOUR + 45 * MINUTE));
      const t3 = new Date(t0.getTime() + (HOUR + 60 * MINUTE));

      let intervalScalar;
      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t1);
      expect(intervalScalar).to.almost.equal(0.0013440860215053765);

      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t2);
      expect(intervalScalar).to.almost.equal(0.0013440860215053765);

      intervalScalar = await Chores.getChoreValueIntervalScalar(HOUSE, t3);
      expect(intervalScalar).to.almost.equal(0.002688172043010753);
    });

    it('can update chore values, storing useful metadata', async () => {
      const choreValues = await Chores.updateChoreValues(HOUSE, now);

      expect(choreValues[0].metadata.ranking).to.almost.equal(0.3333333333333333);
      expect(choreValues[0].metadata.residents).to.equal(2);
    });

    it('can do an end-to-end update of chore values', async () => {
      // Prefer dishes to sweeping, and sweeping to restock
      await Chores.setChorePreference(HOUSE, RESIDENT1, dishes.id, sweeping.id, 1);
      await Chores.setChorePreference(HOUSE, RESIDENT2, sweeping.id, restock.id, 1);

      const t0 = new Date(2000, 3, 10); // April 10 (30 day month), first update gives 72 hours of value
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
      expect(sumPoints1 + sumPoints2).to.almost.equal(pointsPerResident * 2 / 6 * inflationFactor);
    });

    it('can get the current, updated chore values ', async () => {
      const t0 = new Date(2000, 3, 10); // April 10 (30 day month), first update gives 72 hours of value
      const t1 = new Date(t0.getTime() + 48 * HOUR); // 48 hours later

      // Calculate the initial 72 hour update
      await Chores.updateChoreValues(HOUSE, t0);

      // Calculate the 48 hour update and return the total value for 120 hours
      const choreValues = await Chores.getUpdatedChoreValues(HOUSE, t1);
      const sumPoints = choreValues.map(cv => cv.value).reduce((sum, val) => sum + val, 0);
      expect(sumPoints).to.almost.equal(pointsPerResident * 2 / 6 * inflationFactor);
    });
  });

  describe('claiming chores', async () => {
    beforeEach(async () => {
      await Admin.addResident(HOUSE, RESIDENT1, getPrevMonthEnd(now));
      await Admin.addResident(HOUSE, RESIDENT2, getPrevMonthEnd(now));
      await Admin.addResident(HOUSE, RESIDENT3, getPrevMonthEnd(now));
      await Admin.addResident(HOUSE, RESIDENT4, getPrevMonthEnd(now));

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can claim a chore', async () => {
      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 10 },
        { choreId: dishes.id, valuedAt: now, value: 5 }
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      const choreClaim = await Chores.getLatestChoreClaim(dishes.id, soon);
      expect(choreClaim.claimedBy).to.equal(RESIDENT1);
      expect(choreClaim.value).to.equal(15);
    });

    it('cannot claim a chore with a zero value', async () => {
      await expect(Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now))
        .to.be.rejectedWith('Cannot claim a zero-value chore!');
    });

    it('can claim a chore incrementally', async () => {
      // Two separate events
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 5 } ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: soon, value: 20 } ]);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT2, soon);

      expect(choreClaim1.claimedBy).to.equal(RESIDENT1);
      expect(choreClaim1.value).to.equal(15);
      expect(choreClaim2.claimedBy).to.equal(RESIDENT2);
      expect(choreClaim2.value).to.equal(20);
    });

    it('can successfully resolve a claim', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, YAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT2, soon, YAY);

      const [ resolvedClaim ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(resolvedClaim.valid).to.be.true;
      expect(resolvedClaim.value).to.equal(10);
      expect(resolvedClaim.resolvedAt.getTime()).to.equal(challengeEnd.getTime());
    });

    it('can successfully resolve many claims at once', async () => {
      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 10 },
        { choreId: sweeping.id, valuedAt: now, value: 10 },
        { choreId: restock.id, valuedAt: soon, value: 10 }
      ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, sweeping.id, RESIDENT1, now);
      const [ choreClaim3 ] = await Chores.claimChore(HOUSE, restock.id, RESIDENT1, soon);

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
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      await expect(Chores.resolveChoreClaim(choreClaim.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a claim twice', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);

      const [ claimResolution ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(claimResolution).to.be.undefined;
    });

    it('cannot successfully resolve a claim without two positive votes', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, YAY);

      const [ resolvedClaim ] = await Chores.resolveChoreClaim(choreClaim.id, challengeEnd);
      expect(resolvedClaim.valid).to.be.false;
    });

    it('cannot successfully resolve a claim without a passing vote', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

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

      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: t0, value: 10 } ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, t0);

      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: t1, value: 5 } ]);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT2, t1);

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

      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: t0, value: 10 } ]);
      const [ choreClaim1 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, t0);

      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: t1, value: 5 } ]);
      const [ choreClaim2 ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT2, t1);

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
      const y2k = new Date(2000, 1, 1);

      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 10 },
        { choreId: sweeping.id, valuedAt: now, value: 20 }
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT1, now);

      let chorePoints;
      // Can get all chore points this month
      chorePoints = await Chores.getAllChorePoints(RESIDENT1, monthStart, now);
      expect(chorePoints.sum).to.equal(30);

      // Can get chore-specific points this month
      chorePoints = await Chores.getChorePoints(RESIDENT1, dishes.id, monthStart, now);
      expect(chorePoints.sum).to.equal(10);

      // But nothing next month
      chorePoints = await Chores.getAllChorePoints(RESIDENT1, y2k, monthStart);
      expect(chorePoints.sum).to.equal(null);
    });

    it('can calculate chore penalties', async () => {
      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 91 },
        { choreId: sweeping.id, valuedAt: now, value: 80 },
        { choreId: restock.id, valuedAt: now, value: 69 }
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, now);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT3, now);

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
        { choreId: dishes.id, valuedAt: feb1, value: 60 },
        { choreId: sweeping.id, valuedAt: feb1, value: 50 },
        { choreId: restock.id, valuedAt: feb1, value: 40 }
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, feb1);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT2, feb1);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT3, feb1);

      // Everyone takes half the month off
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, feb15, '');
      await Chores.addChoreBreak(HOUSE, RESIDENT2, feb1, feb15, '');
      await Chores.addChoreBreak(HOUSE, RESIDENT3, feb1, feb15, '');

      let penalty;
      const penaltyTime = new Date(getNextMonthStart(feb1).getTime() + penaltyDelay);
      penalty = await Chores.calculatePenalty(RESIDENT1, penaltyTime);
      expect(penalty).to.equal(0);
      penalty = await Chores.calculatePenalty(RESIDENT2, penaltyTime);
      expect(penalty).to.equal(0);
      penalty = await Chores.calculatePenalty(RESIDENT3, penaltyTime);
      expect(penalty).to.equal(0.5);
    });

    it('can add a penalty at the right time', async () => {
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 50 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

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

    it('cannot penalize before initialized', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 50 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      let penaltyHeart;
      const penaltyTime = new Date(getNextMonthStart(now).getTime() + penaltyDelay);

      // No penalty before initialized
      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, penaltyTime);
      expect(penaltyHeart).to.be.undefined;

      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      [ penaltyHeart ] = await Chores.addChorePenalty(HOUSE, RESIDENT1, penaltyTime);
      expect(penaltyHeart.value).to.equal(-2.5);
    });
  });

  describe('managing chore breaks', async () => {
    beforeEach(async () => {
      await Admin.addResident(HOUSE, RESIDENT1, now);
      await Admin.addResident(HOUSE, RESIDENT2, now);
    });

    it('can add, query, and delete chore breaks', async () => {
      const oneDay = new Date(now.getTime() + 1 * DAY);
      const twoDays = new Date(now.getTime() + 2 * DAY);

      let choreBreaks;
      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(0);

      await Chores.addChoreBreak(HOUSE, RESIDENT1, now, oneDay, 'Visiting family');

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(1);
      expect(choreBreaks[0].metadata.circumstance).to.equal('Visiting family');

      await Chores.deleteChoreBreak(choreBreaks[0].id);

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(0);

      await Chores.addChoreBreak(HOUSE, RESIDENT2, now, oneDay, '');
      await Chores.addChoreBreak(HOUSE, RESIDENT2, now, twoDays, '');

      choreBreaks = await Chores.getChoreBreaks(HOUSE, now);
      expect(choreBreaks.length).to.equal(2);
      choreBreaks = await Chores.getChoreBreaks(HOUSE, oneDay);
      expect(choreBreaks.length).to.equal(1);
      choreBreaks = await Chores.getChoreBreaks(HOUSE, twoDays);
      expect(choreBreaks.length).to.equal(0);
    });

    it('can exclude inactive residents from the chore valuing', async () => {
      await Admin.addResident(HOUSE, RESIDENT3, now);
      await Admin.addResident(HOUSE, RESIDENT4, now);

      const oneDay = new Date(now.getTime() + 1 * DAY);
      const twoDays = new Date(now.getTime() + 2 * DAY);
      const oneWeek = new Date(now.getTime() + 7 * DAY);
      const twoWeeks = new Date(now.getTime() + 14 * DAY);
      const lastMonth = new Date(now.getTime() - 35 * DAY);
      const nextMonth = new Date(now.getTime() + 35 * DAY);
      const twoMonths = new Date(now.getTime() + 60 * DAY);

      let residentCount;
      residentCount = await Chores.getActiveResidentCount(HOUSE, now);
      expect(residentCount).to.equal(4);

      // Will exclude inactive residents
      await Admin.deleteResident(HOUSE, RESIDENT4);
      residentCount = await Chores.getActiveResidentCount(HOUSE, now);
      expect(residentCount).to.equal(3);

      // Will count active breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, now, twoDays, '');
      residentCount = await Chores.getActiveResidentCount(HOUSE, now);
      expect(residentCount).to.equal(2);

      // Can handle overlapping breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, now, oneDay, '');
      residentCount = await Chores.getActiveResidentCount(HOUSE, now);
      expect(residentCount).to.equal(2);

      // Can handle new breaks by the same user
      await Chores.addChoreBreak(HOUSE, RESIDENT1, oneWeek, twoWeeks, '');
      residentCount = await Chores.getActiveResidentCount(HOUSE, oneWeek);
      expect(residentCount).to.equal(2);

      // Will also exclude if break extends across months
      await Chores.addChoreBreak(HOUSE, RESIDENT2, lastMonth, nextMonth, '');
      residentCount = await Chores.getActiveResidentCount(HOUSE, now);
      expect(residentCount).to.equal(1);

      // Will not count breaks in the past
      residentCount = await Chores.getActiveResidentCount(HOUSE, twoMonths);
      expect(residentCount).to.equal(3);

      // Will not count breaks in the future
      await Chores.addChoreBreak(HOUSE, RESIDENT3, oneDay, oneWeek, '');
      residentCount = await Chores.getActiveResidentCount(HOUSE, now);
      expect(residentCount).to.equal(1);
    });

    it('can return the percent of the period a resident is not on break', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb15 = new Date(feb1.getTime() + 14 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar1 = new Date(feb1.getTime() + 28 * DAY);
      const mar8 = new Date(mar1.getTime() + 7 * DAY);
      const mar15 = new Date(mar1.getTime() + 14 * DAY);

      let activeDays;

      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(1);

      // Take the first week off
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, feb8, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.75);

      // Take the third week off
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb15, feb22, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.5);

      // Take time off next month, has no effect
      await Chores.addChoreBreak(HOUSE, RESIDENT1, mar1, mar15, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.5);

      // Take the first two weeks off, this break overlaps with the first break
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb1, feb15, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.25);

      // Take the last week off, this break stretches into the next month
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb22, mar8, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.0);
    });

    it('can consider only the parts of breaks in the current month', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar8 = new Date(feb1.getTime() + 35 * DAY);
      const jan25 = new Date(feb1.getTime() - 7 * DAY);

      let activeDays;

      // Overlap last and first weeks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, jan25, feb8, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.75);

      // Overlap last and first weeks
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb22, mar8, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0.5);
    });

    it.skip('can consider a break which starts before and ends after the current month', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const mar8 = new Date(feb1.getTime() + 35 * DAY);
      const jan25 = new Date(feb1.getTime() - 7 * DAY);

      // Add a six-week break
      await Chores.addChoreBreak(HOUSE, RESIDENT1, jan25, mar8, '');
      const activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb1);
      expect(activeDays).to.equal(0);
    });

    it.skip('can consider complex break combinations', async () => {
      const feb15 = new Date(3000, 1, 15);
      const mar1 = new Date(3000, 2, 1);
      const apr1 = new Date(3000, 3, 1); // April, a 30 day month
      const apr7 = new Date(3000, 3, 7);
      const apr10 = new Date(3000, 3, 10);
      const apr22 = new Date(3000, 3, 22);
      const apr25 = new Date(3000, 3, 25);
      const may5 = new Date(3000, 4, 5);

      let activeDays;

      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, apr1);
      expect(activeDays).to.equal(1);

      // Add a six-week break from feb into april (6 day break)
      await Chores.addChoreBreak(HOUSE, RESIDENT1, feb15, apr7, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, feb15);
      expect(activeDays).to.equal(0.5);

      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, mar1);
      expect(activeDays).to.equal(0);

      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, apr1);
      expect(activeDays).to.equal(0.8);

      // Add a week-long break mid-april (12 day break)
      await Chores.addChoreBreak(HOUSE, RESIDENT1, apr10, apr22, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, apr1);
      expect(activeDays).to.equal(0.4);

      // Add a two-week break spanning april and may (6 day break)
      await Chores.addChoreBreak(HOUSE, RESIDENT1, apr25, may5, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT1, apr1);
      expect(activeDays).to.equal(0.2);
    });

    it('can consider the resident activeAt when calculating active percentage', async () => {
      const feb1 = new Date(3000, 1, 1); // February, a 28 day month
      const feb8 = new Date(feb1.getTime() + 7 * DAY);
      const feb22 = new Date(feb1.getTime() + 21 * DAY);
      const mar1 = new Date(feb1.getTime() + 28 * DAY);

      let activeDays;

      await Admin.addResident(HOUSE, RESIDENT3, feb8);

      // activeAt used to create implicit break
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT3, feb1);
      expect(activeDays).to.equal(0.75);

      // Can combine with regular breaks
      await Chores.addChoreBreak(HOUSE, RESIDENT3, feb22, mar1, '');
      activeDays = await Chores.getActiveResidentPercentage(RESIDENT3, feb1);
      expect(activeDays).to.equal(0.5);
    });
  });

  describe('managing chore point gifts', async () => {
    beforeEach(async () => {
      await Admin.addResident(HOUSE, RESIDENT1, now);
      await Admin.addResident(HOUSE, RESIDENT2, now);

      [ dishes ] = await Chores.addChore(HOUSE, 'dishes');
      [ sweeping ] = await Chores.addChore(HOUSE, 'sweeping');
      [ restock ] = await Chores.addChore(HOUSE, 'restock');
    });

    it('can get the largest valid chore claim', async () => {
      await db('ChoreValue').insert([
        { choreId: dishes.id, valuedAt: now, value: 10 },
        { choreId: restock.id, valuedAt: now, value: 30 },
        { choreId: sweeping.id, valuedAt: now, value: 20 }
      ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);
      await Chores.claimChore(HOUSE, restock.id, RESIDENT1, now);
      await Chores.claimChore(HOUSE, sweeping.id, RESIDENT1, now);

      const choreClaim = await Chores.getLargestChoreClaim(RESIDENT1, now, now);
      expect(choreClaim.value).to.equal(30);
    });

    it('can gift chore points', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);

      await Chores.giftChorePoints(HOUSE, RESIDENT1, RESIDENT2, now, 6);

      const monthStart = getMonthStart(now);
      const chorePoints1 = await Chores.getAllChorePoints(RESIDENT1, monthStart, now);
      const chorePoints2 = await Chores.getAllChorePoints(RESIDENT2, monthStart, now);
      expect(chorePoints1.sum).to.equal(4);
      expect(chorePoints2.sum).to.equal(6);
    });

    it('cannot gift more than your current balance', async () => {
      await expect(Chores.giftChorePoints(HOUSE, RESIDENT1, RESIDENT2, now, 10))
        .to.be.rejectedWith('Cannot gift more than the points balance!');
    });

    it('can have a negative balance if a claim is denied after gifting', async () => {
      await db('ChoreValue').insert([ { choreId: dishes.id, valuedAt: now, value: 10 } ]);
      const [ choreClaim ] = await Chores.claimChore(HOUSE, dishes.id, RESIDENT1, now);
      await Chores.giftChorePoints(HOUSE, RESIDENT1, RESIDENT2, now, 6);

      await Polls.submitVote(choreClaim.pollId, RESIDENT1, soon, NAY);
      await Polls.submitVote(choreClaim.pollId, RESIDENT2, soon, NAY);
      await Chores.resolveChoreClaims(HOUSE, challengeEnd);

      const monthStart = getMonthStart(now);
      const chorePoints1 = await Chores.getAllChorePoints(RESIDENT1, monthStart, challengeEnd);
      const chorePoints2 = await Chores.getAllChorePoints(RESIDENT2, monthStart, challengeEnd);
      expect(chorePoints1.sum).to.equal(-6);
      expect(chorePoints2.sum).to.equal(6);
    });
  });

  describe('editing chores', async () => {
    beforeEach(async () => {
      await Admin.addResident(HOUSE, RESIDENT1, now);
      await Admin.addResident(HOUSE, RESIDENT2, now);
    });

    it('can add a chore', async () => {
      let chores;
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const description = 'Rice & beans';
      const [ proposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', { description }, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);
      expect(chores[0].metadata.description).to.equal(description);
    });

    it('can overwrite an existing chore', async () => {
      let chores;
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      let proposal;
      const description = 'Rice & beans';
      [ proposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', { description }, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);
      expect(chores[0].name).to.equal('cooking');
      expect(chores[0].metadata.description).to.equal(description);

      const newDescription = 'Rice & beans with hot sauce';
      [ proposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', { description: newDescription }, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);
      expect(chores[0].name).to.equal('cooking');
      expect(chores[0].metadata.description).to.equal(newDescription);
    });

    it('can delete a chore', async () => {
      const description = 'Washing dishes';
      const [ addProposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cleaning', { description }, now);

      await Polls.submitVote(addProposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(addProposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(addProposal.id, proposalEnd);

      let chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(1);

      const [ deleteProposal ] = await Chores.createDeleteChoreProposal(HOUSE, RESIDENT1, addProposal.choreId, addProposal.name, now);

      await Polls.submitVote(deleteProposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(deleteProposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(deleteProposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);
    });

    it('can edit a chore', async () => {
      let description = 'Wash clothes';
      const [ addProposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'laundry', { description }, now);

      await Polls.submitVote(addProposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(addProposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(addProposal.id, proposalEnd);

      let chores = await Chores.getChores(HOUSE);
      const laundry = chores.find(x => x.name === 'laundry');
      const laundryId = laundry.id;
      expect(laundry.metadata.description).to.equal(description);

      description = 'Wash and dry clothes';
      const [ editProposal ] = await Chores.createEditChoreProposal(HOUSE, RESIDENT1, laundry.id, 'laundry2', { description }, now);

      await Polls.submitVote(editProposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(editProposal.pollId, RESIDENT2, now, YAY);

      await Chores.resolveChoreProposal(editProposal.id, proposalEnd);

      chores = await Chores.getChores(HOUSE);
      const laundry2 = chores.find(x => x.name === 'laundry2');
      expect(laundry2.id).to.equal(laundryId);
      expect(laundry2.metadata.description).to.equal(description);
    });

    it('cannot resolve a proposal before the poll is closed', async () => {
      const description = 'Rice & beans';
      const [ proposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', { description }, now);

      await expect(Chores.resolveChoreProposal(proposal.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a proposal twice', async () => {
      const description = 'Rice & beans';
      const [ proposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', { description }, now);

      await Chores.resolveChoreProposal(proposal.id, proposalEnd);

      await expect(Chores.resolveChoreProposal(proposal.id, proposalEnd))
        .to.be.rejectedWith('Proposal already resolved!');
    });

    it('cannot approve a proposal with insufficient votes', async () => {
      await Admin.addResident(HOUSE, RESIDENT3, now);
      await Admin.addResident(HOUSE, RESIDENT4, now);

      let chores;
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const description = 'Rice & beans';
      const [ proposal ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', { description }, now);

      // 40% of 4 residents is 2 upvotes
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
      let chores;
      chores = await Chores.getChores(HOUSE);
      expect(chores.length).to.equal(0);

      const [ proposal1 ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'cooking', {}, now);
      const [ proposal2 ] = await Chores.createAddChoreProposal(HOUSE, RESIDENT1, 'laundry', {}, now);

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
