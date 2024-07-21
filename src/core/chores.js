const assert = require('assert');

const { db } = require('./db');

const { HOUR, DAY, HEART_CHORE } = require('../constants');
const { getMonthStart, getMonthEnd, getPrevMonthEnd, getNextMonthStart, getDateStart } = require('../utils');

const {
  pointsPerResident,
  inflationFactor,
  bootstrapDuration,
  choresMinVotes,
  choreMinVotesThreshold,
  penaltyIncrement,
  penaltyDelay,
  choresPollLength,
  dampingFactor,
  choresProposalPollLength,
  choreProposalPct,
} = require('../config');

const Admin = require('./admin');
const Hearts = require('./hearts');
const Polls = require('./polls');
const { PowerRanker } = require('./power');

// Chores

exports.addChore = async function (houseId, name, metadata) {
  return db('Chore')
    .insert({ houseId, name, metadata, active: true })
    .onConflict([ 'houseId', 'name' ]).merge()
    .returning('*');
};

// NOTE: also used for deletion
// NOTE: add and edit are distinct actions, since editing supports name changes
exports.editChore = async function (choreId, name, metadata, active) {
  return db('Chore')
    .where({ id: choreId })
    .update({ name, metadata, active })
    .returning('*');
};

exports.getChores = async function (houseId) {
  return db('Chore')
    .select('*')
    .where({ houseId })
    .where('active', true);
};

exports.getChore = async function (choreId) {
  return db('Chore')
    .select('*')
    .where({ id: choreId })
    .first();
};

// Chore Preferences

exports.getChorePreferences = async function (houseId) {
  return db('ChorePref')
    .where({ houseId })
    .select('residentId', 'alphaChoreId', 'betaChoreId', 'preference');
};

exports.getResidentChorePreferences = async function (houseId, residentId) {
  return db('ChorePref')
    .where({ houseId, residentId })
    .select('residentId', 'alphaChoreId', 'betaChoreId', 'preference');
};

exports.getActiveChorePreferences = async function (houseId, now) {
  return db('ChorePref')
    .join('Chore AS AlphaChore', 'ChorePref.alphaChoreId', 'AlphaChore.id')
    .join('Chore AS BetaChore', 'ChorePref.betaChoreId', 'BetaChore.id')
    .join('Resident', 'ChorePref.residentId', 'Resident.slackId')
    .where('ChorePref.houseId', houseId)
    .where('Resident.activeAt', '<=', now)
    .where('AlphaChore.active', true)
    .where('BetaChore.active', true)
    .select('residentId', 'alphaChoreId', 'betaChoreId', 'preference');
};

exports.setChorePreferences = async function (houseId, prefs) {
  return db('ChorePref')
    .insert(prefs.map((p) => { return { houseId, ...p }; }))
    .onConflict([ 'houseId', 'residentId', 'alphaChoreId', 'betaChoreId' ]).merge();
};

// Chore Preference Processing

exports.mergeChorePreferences = function (currentPrefs, newPrefs) {
  const currentPrefsMap = exports.toPreferenceMap(currentPrefs);

  newPrefs.forEach((p) => {
    const prefKey = exports.toPrefKey(p);
    currentPrefsMap.set(prefKey, p);
  });

  return Array.from(currentPrefsMap.values());
};

exports.normalizeChorePreference = function (pref) {
  // If already normalized, no-op
  // NOTE: Typescript would be useful here
  if (pref.alphaChoreId || pref.betaChoreId) {
    assert(pref.alphaChoreId < pref.betaChoreId, 'Invalid chore preference!');
    return pref;
  }

  let alphaChoreId, betaChoreId, preference;

  // Value flows from source to target, and from beta to alpha
  if (pref.targetChoreId < pref.sourceChoreId) {
    alphaChoreId = pref.targetChoreId;
    betaChoreId = pref.sourceChoreId;
    preference = pref.preference;
  } else {
    alphaChoreId = pref.sourceChoreId;
    betaChoreId = pref.targetChoreId;
    preference = 1 - pref.preference;
  }

  return { alphaChoreId, betaChoreId, preference };
};

exports.filterChorePreferences = async function (houseId, residentId, prefs) {
  return prefs
    .filter(p => p.targetChoreId !== p.sourceChoreId)
    .map((p) => { return { residentId, ...exports.normalizeChorePreference(p) }; });
};

exports.toPreferenceMap = function (prefs) {
  return new Map(prefs.map(p => [ exports.toPrefKey(p), p ]));
};

exports.toPrefKey = function (pref) {
  assert(pref.residentId && pref.alphaChoreId && pref.betaChoreId, 'Invalid chore preference!');
  return `${pref.residentId}-${pref.alphaChoreId}-${pref.betaChoreId}`;
};

// Chore Values

exports.getChoreValue = async function (choreId, startTime, endTime) {
  const choreValue = await db('ChoreValue')
    .where({ choreId })
    .where('valuedAt', '>', startTime)
    .where('valuedAt', '<=', endTime)
    .sum('value')
    .first();

  return choreValue.sum || 0;
};

exports.getCurrentChoreValue = async function (choreId, currentTime, excludedClaimId = null) {
  const latestClaim = await exports.getLatestChoreClaim(choreId, currentTime, excludedClaimId);
  const latestClaimedAt = (latestClaim === undefined) ? new Date(0) : latestClaim.claimedAt;
  return exports.getChoreValue(choreId, latestClaimedAt, currentTime);
};

exports.getCurrentChoreValues = async function (houseId, currentTime) {
  const choreValues = [];
  const chores = await exports.getChores(houseId);

  for (const chore of chores) {
    const choreValue = await exports.getCurrentChoreValue(chore.id, currentTime);
    choreValues.push({ id: chore.id, name: chore.name, value: choreValue });
  }

  return choreValues;
};

exports.getCurrentChoreRankings = async function (houseId, now) {
  const preferences = await exports.getActiveChorePreferences(houseId, now);
  return exports.getChoreRankings(houseId, now, preferences);
};

exports.getProposedChoreRankings = async function (houseId, newPrefs, now) {
  const currentPrefs = await exports.getActiveChorePreferences(houseId, now);
  const proposedPrefs = exports.mergeChorePreferences(currentPrefs, newPrefs);
  return exports.getChoreRankings(houseId, now, proposedPrefs);
};

exports.getChoreRankings = async function (houseId, now, preferences) {
  const chores = await exports.getChores(houseId);
  const residents = await Admin.getResidents(houseId, now);

  const choresSet = new Set(chores.map(c => c.id));
  const formattedPreferences = preferences.map((p) => {
    return { alpha: p.alphaChoreId, beta: p.betaChoreId, preference: p.preference };
  });

  const powerRanker = new PowerRanker(choresSet, formattedPreferences, residents.length);
  const rankings = powerRanker.run(d = dampingFactor); // eslint-disable-line no-undef

  return chores.map((chore) => {
    return { id: chore.id, name: chore.name, ranking: rankings.get(chore.id) };
  }).sort((a, b) => b.ranking - a.ranking);
};

exports.getChoreValueIntervalScalar = async function (houseId, updateTime) {
  const lastChoreValue = await exports.getLastChoreValueUpdate(houseId);
  const lastUpdateTime = (lastChoreValue)
    ? lastChoreValue.valuedAt
    : new Date(updateTime.getTime() - bootstrapDuration); // First update seeds a fixed amount of value

  const hoursSinceUpdate = Math.max(Math.floor((updateTime - lastUpdateTime) / HOUR), 0);
  const hoursInMonth = 24 * getMonthEnd(updateTime).getDate();

  // TODO: handle scenario where interval spans 2 months

  return (hoursSinceUpdate / hoursInMonth);
};

exports.getLastChoreValueUpdate = async function (houseId) {
  return db('ChoreValue')
    .join('Chore', 'ChoreValue.choreId', 'Chore.id')
    .where('Chore.houseId', houseId)
    .orderBy('ChoreValue.valuedAt', 'desc')
    .select('ChoreValue.valuedAt')
    .first();
};

exports.updateChoreValues = async function (houseId, now) {
  const updateTime = truncateHour(now);
  // TODO: lock tables during this function call
  const intervalScalar = await exports.getChoreValueIntervalScalar(houseId, updateTime);

  // If we've updated in the last interval, short-circuit execution
  if (intervalScalar === 0) { return Promise.resolve([]); }

  const workingResidentCount = await exports.getWorkingResidentCount(houseId, now);
  const updateScalar = (workingResidentCount * pointsPerResident) * intervalScalar * inflationFactor;
  const choreRankings = await exports.getCurrentChoreRankings(houseId, now);
  const metadata = { intervalScalar, residents: workingResidentCount };

  const choreValues = choreRankings.map((chore) => {
    return {
      houseId,
      choreId: chore.id,
      valuedAt: updateTime,
      value: chore.ranking * updateScalar,
      metadata: { ...metadata, ranking: chore.ranking },
    };
  });

  return db('ChoreValue')
    .insert(choreValues)
    .returning('*');
};

// Round down to the nearest hour
function truncateHour (date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
}

exports.getUpdatedChoreValues = async function (houseId, updateTime) {
  // By doing it this way, we avoid race conditions
  const choreValues = await exports.getCurrentChoreValues(houseId, updateTime);
  const choreValueUpdates = await exports.updateChoreValues(houseId, updateTime);

  const updateMap = new Map(choreValueUpdates.map(update => [ update.choreId, update.value ]));
  choreValues.forEach((choreValue) => { choreValue.value += updateMap.get(choreValue.id) || 0; });

  return choreValues.sort((a, b) => b.value - a.value);
};

// Chore Claims

exports.getChoreClaim = async function (claimId) {
  return db('ChoreClaim')
    .select('*')
    .where({ id: claimId })
    .first();
};

exports.getChoreClaims = async function (claimedBy, startTime, endTime) {
  return db('ChoreClaim')
    .join('Chore', 'ChoreClaim.choreId', 'Chore.id')
    .where({ claimedBy, valid: true })
    .whereBetween('claimedAt', [ startTime, endTime ])
    .orderBy('claimedAt')
    .select('Chore.name', 'ChoreClaim.claimedAt', 'ChoreClaim.value', 'ChoreClaim.metadata');
};

exports.getLatestChoreClaim = async function (choreId, currentTime, excludedClaimId = null) {
  return db('ChoreClaim')
    .select('*')
    .where({ choreId, valid: true })
    .where('claimedAt', '<=', currentTime)
    .whereNot({ id: excludedClaimId }) // Exclude the current claim, if any
    .orderBy('claimedAt', 'desc')
    .first();
};

exports.claimChore = async function (houseId, choreId, claimedBy, claimedAt, timeSpent) {
  const choreValue = await exports.getCurrentChoreValue(choreId, claimedAt);

  assert(choreValue, 'Cannot claim a zero-value chore!');

  const minVotes = (choreValue >= choreMinVotesThreshold) ? choresMinVotes : 1;
  const [ poll ] = await Polls.createPoll(houseId, claimedAt, choresPollLength, minVotes);

  return db('ChoreClaim')
    .insert({
      houseId,
      choreId,
      claimedBy,
      claimedAt,
      value: choreValue,
      pollId: poll.id,
      metadata: { timeSpent },
    })
    .returning('*');
};

exports.resolveChoreClaim = async function (claimId, resolvedAt) {
  const choreClaim = await exports.getChoreClaim(claimId);
  const valid = await Polls.isPollValid(choreClaim.pollId, resolvedAt);
  const value = await exports.getCurrentChoreValue(choreClaim.choreId, choreClaim.claimedAt, claimId);

  return db('ChoreClaim')
    .where({ id: claimId, resolvedAt: null }) // Cannot resolve twice
    .update({ resolvedAt, valid, value })
    .returning('*');
};

exports.resolveChoreClaims = async function (houseId, now) {
  const resolvableChoreClaims = await db('ChoreClaim')
    .join('Poll', 'ChoreClaim.pollId', 'Poll.id')
    .where('ChoreClaim.houseId', houseId)
    .where('ChoreClaim.resolvedAt', null)
    .where('Poll.endTime', '<=', now)
    .select('ChoreClaim.id');

  const resolvedChoreClaims = resolvableChoreClaims
    .map(choreClaim => exports.resolveChoreClaim(choreClaim.id, now));

  return (await Promise.all(resolvedChoreClaims)).flat();
};

exports.getChorePoints = async function (claimedBy, choreId, startTime, endTime) {
  const chorePoints = await db('ChoreClaim')
    .where({ claimedBy, choreId, valid: true })
    .whereBetween('claimedAt', [ startTime, endTime ])
    .sum('value')
    .first();

  return chorePoints.sum || 0;
};

exports.getAllChorePoints = async function (claimedBy, startTime, endTime) {
  const chorePoints = await db('ChoreClaim')
    .where({ claimedBy, valid: true })
    .whereBetween('claimedAt', [ startTime, endTime ])
    .sum('value')
    .first();

  return chorePoints.sum || 0;
};

// Chore Breaks

exports.addChoreBreak = async function (houseId, residentId, startDate, endDate, circumstance) {
  return db('ChoreBreak')
    .insert({ houseId, residentId, startDate, endDate, metadata: { circumstance } })
    .returning('*');
};

exports.deleteChoreBreak = async function (choreBreakId) {
  return db('ChoreBreak')
    .where({ id: choreBreakId })
    .del();
};

// Only consider breaks from voting residents
exports.getChoreBreaks = async function (houseId, now) {
  return db('ChoreBreak')
    .leftJoin('Resident', 'ChoreBreak.residentId', 'Resident.slackId')
    .where('ChoreBreak.houseId', houseId)
    .where('ChoreBreak.startDate', '<=', now)
    .where('ChoreBreak.endDate', '>', now)
    .where('Resident.activeAt', '<=', now)
    .where(function () { Admin.residentNotExempt(this, now); })
    .returning('*');
};

// Working residents are voting residents not on break
exports.getWorkingResidents = async function (houseId, now) {
  const residents = await Admin.getVotingResidents(houseId, now);
  const choreBreaks = await exports.getChoreBreaks(houseId, now);

  const breakSet = new Set(choreBreaks.map(cb => cb.residentId));
  return residents.filter(r => !breakSet.has(r.slackId));
};

exports.getWorkingResidentCount = async function (houseId, now) {
  const workingResidents = await exports.getWorkingResidents(houseId, now);
  return workingResidents.length;
};

// TODO: Allow caller to supply startTime and endTime
exports.getWorkingResidentPercentage = async function (residentId, now) {
  const resident = await Admin.getResident(residentId);
  const monthStart = getMonthStart(now);
  const monthEnd = getMonthEnd(now);

  // Want past, current, and future breaks for the month
  const choreBreaks = await db('ChoreBreak')
    .where({ residentId })
    .where(function () {
      // Either startDate or endDate is betwen monthStart and monthEnd
      this.where(function () {
        this.whereBetween('startDate', [ monthStart, monthEnd ])
          .orWhereBetween('endDate', [ monthStart, monthEnd ]);
      })
        // Or now falls between startDate & endDate
        .orWhere(function () {
          this.where('startDate', '<=', now)
            .where('endDate', '>', now);
        });
    })
    .select('*');

  // Add an implicit break before activeAt
  if (monthStart < resident.activeAt) {
    const activeAt = getDateStart(resident.activeAt);
    choreBreaks.push({ startDate: monthStart, endDate: activeAt });
  }
  // Add an implicit break after exemptAt
  if (resident.exemptAt && resident.exemptAt < monthEnd) {
    const exemptAt = getDateStart(resident.exemptAt);
    choreBreaks.push({ startDate: exemptAt, endDate: monthEnd });
  }

  // TODO: implement this more efficiently... currently O(n) but could probably be O(1)
  const daysInMonth = monthEnd.getDate();
  const workingDays = new Map([ ...Array(daysInMonth).keys() ].map(day => [ day, true ]));

  for (const choreBreak of choreBreaks) {
    let startDate = new Date(Math.max(choreBreak.startDate, monthStart));
    const endDate = new Date(Math.min(choreBreak.endDate, getNextMonthStart(monthEnd)));
    while (startDate < endDate) {
      workingDays.set(startDate.getDate() - 1, false);
      startDate = new Date(startDate.getTime() + DAY);
    }
  }

  const numWorkingDays = Array.from(workingDays.values()).filter(x => x).length;
  return numWorkingDays / daysInMonth;
};

exports.addChorePenalties = async function (houseId, now) {
  // TODO: Add specialized Hearts query to avoid two roundtrips to database
  const chorePenalties = (await Admin.getVotingResidents(houseId, now))
    .map(resident => exports.addChorePenalty(houseId, resident.slackId, now));

  return (await Promise.all(chorePenalties)).flat();
};

exports.addChorePenalty = async function (houseId, residentId, currentTime) {
  const monthStart = getMonthStart(currentTime);
  const penaltyTime = new Date(monthStart.getTime() + penaltyDelay);
  if (currentTime < penaltyTime) { return []; }

  const penaltyHeart = await Hearts.getHeart(residentId, penaltyTime);
  if (!penaltyHeart) {
    const hearts = await Hearts.getHearts(residentId, penaltyTime);
    if (hearts.sum === null) { return []; } // Don't penalize if not initialized

    const penaltyAmount = await exports.calculatePenalty(residentId, penaltyTime);
    return Hearts.generateHearts(houseId, residentId, HEART_CHORE, penaltyTime, -penaltyAmount);
  } else {
    return [];
  }
};

// Chore Stats

exports.getChoreStats = async function (residentId, startTime, endTime) {
  const pointsEarned = await exports.getAllChorePoints(residentId, startTime, endTime);
  const workingPercentage = await exports.getWorkingResidentPercentage(residentId, endTime);
  const pointsOwed = pointsPerResident * workingPercentage;
  const completionPct = (pointsOwed) ? pointsEarned / pointsOwed : 1;

  return { pointsEarned, pointsOwed, completionPct };
};

exports.getHouseChoreStats = async function (houseId, startTime, endTime) {
  const residents = await Admin.getVotingResidents(houseId, endTime);
  const choreStats = await Promise.all(residents.map(async (r) => {
    const choreStats = await exports.getChoreStats(r.slackId, startTime, endTime);
    return { residentId: r.slackId, ...choreStats };
  }));
  return choreStats.sort((a, b) => b.completionPct - a.completionPct); // Descending order
};

exports.calculatePenalty = async function (residentId, penaltyTime) {
  const prevMonthEnd = getPrevMonthEnd(penaltyTime);
  const prevMonthStart = getMonthStart(prevMonthEnd);
  const choreStats = await exports.getChoreStats(residentId, prevMonthStart, prevMonthEnd);

  const deficiency = choreStats.pointsOwed - choreStats.pointsEarned;

  if (deficiency <= 0) {
    return -0.5;
  } else {
    const truncatedDeficiency = Math.floor(deficiency / penaltyIncrement) * penaltyIncrement;
    return truncatedDeficiency / (2 * penaltyIncrement);
  }
};

// Chore Point Gifting

exports.giftChorePoints = async function (houseId, gifterId, recipientId, giftedAt, value) {
  const monthStart = getMonthStart(giftedAt);
  const gifterChorePoints = await exports.getAllChorePoints(gifterId, monthStart, giftedAt);

  assert(gifterChorePoints >= value, 'Cannot gift more than the points balance!');

  await db('ChoreClaim')
    .insert([
      { houseId, claimedBy: gifterId, claimedAt: giftedAt, value: -value },
      { houseId, claimedBy: recipientId, claimedAt: giftedAt, value },
    ])
    .returning('*');
};

// Chore Proposals

exports.createChoreProposal = async function (houseId, proposedBy, choreId, name, metadata, active, now) {
  // TODO: Can this be done as a table constraint?
  assert(choreId || name, 'Proposal must include either choreId or name!');

  const minVotes = await exports.getChoreProposalMinVotes(houseId, now);
  const [ poll ] = await Polls.createPoll(houseId, now, choresProposalPollLength, minVotes);

  return db('ChoreProposal')
    .insert({ houseId, proposedBy, choreId, name, metadata, active, pollId: poll.id })
    .returning('*');
};

exports.getChoreProposal = async function (proposalId) {
  return db('ChoreProposal')
    .select('*')
    .where({ id: proposalId })
    .first();
};

exports.getChoreProposalMinVotes = async function (houseId, now) {
  const votingResidents = await Admin.getVotingResidents(houseId, now);
  return Math.ceil(choreProposalPct * votingResidents.length);
};

exports.resolveChoreProposal = async function (proposalId, now) {
  const proposal = await exports.getChoreProposal(proposalId);

  assert(!proposal.resolvedAt, 'Proposal already resolved!');

  const valid = await Polls.isPollValid(proposal.pollId, now);

  if (valid) {
    const { houseId, choreId, name, metadata, active } = proposal;
    if (!choreId) {
      await exports.addChore(houseId, name, metadata);
    } else {
      await exports.editChore(choreId, name, metadata, active);
    }
  }

  return db('ChoreProposal')
    .where({ id: proposalId })
    .update({ resolvedAt: now })
    .returning('*');
};

exports.resolveChoreProposals = async function (houseId, now) {
  const resolveableProposals = await db('ChoreProposal')
    .join('Poll', 'ChoreProposal.pollId', 'Poll.id')
    .where('ChoreProposal.houseId', houseId)
    .where('Poll.endTime', '<=', now)
    .where('ChoreProposal.resolvedAt', null)
    .orderBy('Poll.endTime') // Ensure sequential resolution
    .select('ChoreProposal.id');

  const resolvedProposals = resolveableProposals
    .map(proposal => exports.resolveChoreProposal(proposal.id, now));

  return (await Promise.all(resolvedProposals)).flat();
};

// Reset chore points

exports.resetChorePoints = async function (houseId, now) {
  const residents = await Admin.getVotingResidents(houseId, now);
  const resetResidents = residents.map((r) => {
    return { houseId, slackId: r.slackId, activeAt: now, exemptAt: null }; // activeAt = now
  });

  const monthStart = getMonthStart(now);
  const resetResidentClaims = await Promise.all(residents.map(async (r) => {
    const userPoints = await exports.getAllChorePoints(r.slackId, monthStart, now);
    return { houseId, claimedBy: r.slackId, value: -userPoints, claimedAt: now }; // choreId = null
  }));

  const choreValues = await exports.getUpdatedChoreValues(houseId, now);
  const resetChoreClaims = choreValues.map((cv) => {
    return { houseId, choreId: cv.id, value: cv.value, claimedAt: now }; // claimedBy = null
  });

  await db.transaction(async (tx) => {
    await tx('Resident').insert(resetResidents).onConflict('slackId').merge(); // HACK: write Resident table directly
    await tx('ChoreClaim').insert([ ...resetResidentClaims, ...resetChoreClaims ]);
  });
};
