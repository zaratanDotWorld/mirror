const assert = require('assert');

const { db } = require('./db');

const { getMonthStart, getPrevMonthEnd } = require('../utils');
const { HEART_REGEN, HEART_CHALLENGE, HEART_KARMA, HEART_REVIVE } = require('../constants');

const {
  heartsMinPctInitial,
  heartsMinPctCritical,
  heartsBaselineAmount,
  heartsReviveAmount,
  heartsRegenAmount,
  heartsFadeAmount,
  heartsPollLength,
  karmaDelay,
  karmaProportion,
  heartsMaxBase,
  heartsMaxLimit,
  heartsKarmaGrowthRate,
  heartsCriticalNum,
  heartsVoteScalar,
} = require('../config');

const Admin = require('./admin');
const Polls = require('./polls');

// Hearts

exports.getHeart = async function (residentId, generatedAt) {
  return db('Heart')
    .where({ residentId, generatedAt })
    .first();
};

exports.getAgnosticHearts = async function (houseId, generatedAt) {
  return db('Heart')
    .where({ houseId, generatedAt });
};

exports.getHearts = async function (residentId, now) {
  const hearts = await db('Heart')
    .where({ residentId })
    .where('generatedAt', '<=', now)
    .sum('value')
    .first();

  return hearts.sum;
};

exports.getHouseHearts = async function (houseId, now) {
  return db('Heart')
    .join('Resident', 'Heart.residentId', 'Resident.slackId')
    .where('Heart.houseId', houseId)
    .where('Heart.generatedAt', '<=', now)
    .where('Resident.activeAt', '<=', now)
    .groupBy('Heart.residentId')
    .select('Heart.residentId')
    .sum('Heart.value')
    .orderBy('sum', 'desc');
};

exports.generateHearts = async function (houseId, residentId, type, generatedAt, value) {
  return db('Heart')
    .insert({ houseId, residentId, type, generatedAt, value })
    .returning('*');
};

exports.initialiseResident = async function (houseId, residentId, now) {
  const hearts = await exports.getHearts(residentId, now);
  if (hearts === null) {
    return exports.generateHearts(houseId, residentId, HEART_REGEN, now, heartsBaselineAmount);
  } else { return []; }
};

exports.reviveResident = async function (houseId, residentId, now) {
  const hearts = await exports.getHearts(residentId, now);
  if (hearts <= 0) {
    return exports.generateHearts(houseId, residentId, HEART_REVIVE, now, heartsReviveAmount - hearts);
  } else { return []; }
};

exports.reviveResidents = async function (houseId, now) {
  const revivedResidents = (await Admin.getResidents(houseId, now))
    .map(resident => exports.reviveResident(houseId, resident.slackId, now));

  return (await Promise.all(revivedResidents)).flat();
};

exports.regenerateHearts = async function (houseId, residentId, now) {
  const regenTime = getMonthStart(now);
  if (now < regenTime) { return []; }

  const regeneration = await exports.getHeart(residentId, regenTime);
  if (!regeneration) {
    const hearts = await exports.getHearts(residentId, regenTime);
    if (hearts === null) { return []; } // Don't regenerate if not initialized

    const regenAmount = exports.getRegenAmount(hearts);
    return exports.generateHearts(houseId, residentId, HEART_REGEN, regenTime, regenAmount);
  } else { return []; }
};

exports.getRegenAmount = function (currentHearts) {
  // Want to move `heartsRegenAmount` up towards `heartsBaselineAmount`
  //   and `heartsFadeAmount` down towards `heartsBaselineAmount`
  const baselineGap = heartsBaselineAmount - currentHearts;
  return (baselineGap >= 0)
    ? Math.min(heartsRegenAmount, baselineGap)
    : Math.max(-heartsFadeAmount, baselineGap);
};

exports.regenerateHouseHearts = async function (houseId, now) {
  const houseHearts = (await Admin.getResidents(houseId, now))
    .map(resident => exports.regenerateHearts(houseId, resident.slackId, now));

  return (await Promise.all(houseHearts)).flat();
};

// Challenges

exports.issueChallenge = async function (houseId, challengerId, challengeeId, value, challengedAt, circumstance) {
  const unresolvedChallenges = await exports.getUnresolvedChallenges(houseId, challengeeId);

  assert(!unresolvedChallenges.length, 'Active challenge exists!');

  const minVotes = await exports.getChallengeMinVotes(houseId, challengeeId, value, challengedAt);
  const [ poll ] = await Polls.createPoll(houseId, challengedAt, heartsPollLength, minVotes);

  return db('HeartChallenge')
    .insert({ houseId, challengerId, challengeeId, challengedAt, value, pollId: poll.id, metadata: { circumstance } })
    .returning('*');
};

exports.getChallenge = async function (challengeId) {
  return db('HeartChallenge')
    .select('*')
    .where('id', challengeId)
    .first();
};

exports.getUnresolvedChallenges = async function (houseId, challengeeId) {
  return db('HeartChallenge')
    .where({ houseId, challengeeId, heartId: null })
    .select('*');
};

exports.getChallengeMinVotes = async function (houseId, challengeeId, value, challengedAt) {
  const residents = await Admin.getResidents(houseId, challengedAt);
  const challengeeHearts = await exports.getHearts(challengeeId, challengedAt);
  return (challengeeHearts - value <= heartsCriticalNum)
    ? Math.ceil(residents.length * heartsMinPctCritical)
    : Math.ceil(residents.length * heartsMinPctInitial);
};

exports.resolveChallenge = async function (challengeId, resolvedAt) {
  const challenge = await exports.getChallenge(challengeId);
  const { houseId, challengerId, challengeeId, value } = challenge;

  assert(!challenge.heartId, 'Challenge already resolved!');

  const valid = await Polls.isPollValid(challenge.pollId, resolvedAt);
  const loser = (valid) ? challengeeId : challengerId;

  const [ heart ] = await exports.generateHearts(houseId, loser, HEART_CHALLENGE, resolvedAt, -value);

  return db('HeartChallenge')
    .where({ id: challengeId })
    .update({ resolvedAt, heartId: heart.id })
    .returning('*');
};

exports.resolveChallenges = async function (houseId, now) {
  const resolvableChallenges = await db('HeartChallenge')
    .join('Poll', 'HeartChallenge.pollId', 'Poll.id')
    .where('HeartChallenge.houseId', houseId)
    .where('Poll.endTime', '<=', now)
    .where('HeartChallenge.resolvedAt', null)
    .select('HeartChallenge.id');

  const resolvedChallenges = resolvableChallenges
    .map(challenge => exports.resolveChallenge(challenge.id, now));

  return (await Promise.all(resolvedChallenges)).flat();
};

// Karma

exports.getKarmaRecipients = function (text) {
  let match;
  const matches = [];
  const regex = /<@(\w+)>\s*\+\+/g; // Matches`<@username>++`
  while ((match = regex.exec(text))) { matches.push(match[1]); }
  return matches;
};

exports.getKarma = async function (houseId, startTime, endTime) {
  return db('HeartKarma')
    .where({ houseId })
    .whereBetween('givenAt', [ startTime, endTime ])
    .select('*');
};

exports.giveKarma = async function (houseId, giverId, receiverId, givenAt) {
  return db('HeartKarma')
    .insert({ houseId, giverId, receiverId, givenAt })
    .returning('*');
};

exports.getKarmaRankings = async function (houseId, startTime, endTime) {
  const karma = await exports.getKarma(houseId, startTime, endTime);
  if (!karma.length) return [];

  const hearts = await exports.getHouseHearts(houseId, endTime);

  // Sum up issued karma per giver
  const issued = karma.reduce((obj, k) => {
    obj[k.giverId] = (obj[k.giverId] || 0) + 1;
    return obj;
  }, {});

  // Divide giver hearts by issued karma to get influence
  const influence = hearts.reduce((obj, h) => {
    obj[h.residentId] = h.sum / (issued[h.residentId] || 1);
    return obj;
  }, {});

  // Sum up influence per receiver
  const rankings = karma.reduce((obj, k) => {
    obj[k.receiverId] = (obj[k.receiverId] || 0) + influence[k.giverId];
    return obj;
  }, {});

  return Object.entries(rankings)
    .map(([ slackId, ranking ]) => ({ slackId, ranking }))
    .sort((a, b) => b.ranking - a.ranking);
};

exports.getNumKarmaWinners = async function (houseId, startTime, endTime) {
  const residents = await Admin.getResidents(houseId, endTime);
  const maxWinners = Math.floor(residents.length / karmaProportion);

  const karma = await exports.getKarma(houseId, startTime, endTime);
  const uniqueReceivers = (new Set(karma.map(k => k.receiverId))).size;

  return Math.min(maxWinners, uniqueReceivers);
};

exports.generateKarmaHearts = async function (houseId, now) {
  const monthStart = getMonthStart(now);
  const generatedAt = new Date(monthStart.getTime() + karmaDelay);
  if (now < generatedAt) { return []; }

  const prevMonthEnd = getPrevMonthEnd(now);
  const prevMonthStart = getMonthStart(prevMonthEnd);
  const numWinners = await exports.getNumKarmaWinners(houseId, prevMonthStart, prevMonthEnd);
  if (numWinners <= 0) { return []; }

  const karmaHearts = await exports.getAgnosticHearts(houseId, generatedAt);
  if (!karmaHearts.length) {
    const karmaRankings = await exports.getKarmaRankings(houseId, prevMonthStart, prevMonthEnd);

    for (const winner of karmaRankings.slice(0, numWinners)) {
      const residentId = winner.slackId;
      const type = HEART_KARMA;
      const metadata = { ranking: winner.ranking };

      const maxHearts = await exports.getResidentMaxHearts(residentId, generatedAt);
      const hearts = await exports.getHearts(residentId, generatedAt);
      const value = Math.min(1, Math.max(0, maxHearts - hearts)); // Bring to maximum

      karmaHearts.push({ houseId, residentId, type, generatedAt, value, metadata });
    }

    return exports.insertKarmaHearts(karmaHearts);
  } else { return []; }
};

exports.insertKarmaHearts = async function (karmaHearts) {
  return db('Heart')
    .insert(karmaHearts)
    .returning('*');
};

exports.getKarmaHearts = async function (residentId, now) {
  return db('Heart')
    .where({ residentId, type: HEART_KARMA })
    .where('generatedAt', '<=', now)
    .returning('*');
};

exports.getResidentMaxHearts = async function (residentId, now) {
  const karmaHearts = await exports.getKarmaHearts(residentId, now);
  return Math.min(
    heartsMaxBase + Math.floor(karmaHearts.length / heartsKarmaGrowthRate),
    heartsMaxLimit,
  );
};

// Utilities

exports.getHeartsVoteScalar = async function (residentId, now) {
  const hearts = await exports.getHearts(residentId, now);
  const heartsValue = (hearts === null) ? heartsBaselineAmount : hearts;
  return 1 - ((heartsValue - heartsBaselineAmount) * heartsVoteScalar);
};
