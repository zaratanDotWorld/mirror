const assert = require('assert');
const sha256 = require('js-sha256');

const { db } = require('./db');

const Admin = require('./admin');

exports.createPoll = async function (houseId, startTime, duration, minVotes) {
  const endTime = new Date(startTime.getTime() + duration);
  return db('Poll')
    .insert({ houseId, startTime, endTime, minVotes })
    .returning('*');
};

exports.getPoll = async function (pollId) {
  return db('Poll')
    .where({ id: pollId })
    .select('*')
    .first();
};

exports.submitVote = async function (pollId, residentId, now, vote) {
  const poll = await exports.getPoll(pollId);
  const resident = await Admin.getResident(residentId);
  const encryptedResidentId = sha256(process.env.SALT + residentId);

  assert(poll.houseId === resident.houseId, 'Invalid user for poll!');
  assert(now < poll.endTime, 'Poll has closed!');

  await db('PollVote')
    .insert({ pollId, encryptedResidentId, submittedAt: now, vote })
    .onConflict([ 'pollId', 'encryptedResidentId' ]).merge();

  const pollResults = await exports.getPollResults(pollId);
  const residents = await Admin.getResidents(poll.houseId, now);

  // If everyone has voted, close the poll
  if (pollResults.length >= residents.length) {
    await db('Poll')
      .where({ id: pollId })
      .update({ endTime: now });
  }
};

exports.getPollResults = async function (pollId) {
  // TODO: implement using a join on poll (there's some timestamp issue)
  const poll = await exports.getPoll(pollId);
  return db('PollVote')
    .where({ pollId })
    .whereBetween('submittedAt', [ poll.startTime, poll.endTime ]) // Inclusive
    .select('*');
};

exports.getPollResultCounts = async function (pollId) {
  const votes = await exports.getPollResults(pollId);
  const yays = votes.filter(v => v.vote === true).length;
  const nays = votes.filter(v => v.vote === false).length;
  return { yays, nays };
};

exports.isPollValid = async function (pollId, now) {
  const poll = await exports.getPoll(pollId);

  assert(poll.endTime <= now, 'Poll not closed!');

  const { yays, nays } = await exports.getPollResultCounts(pollId);
  return (yays >= poll.minVotes && yays > nays);
};

exports.updateMetadata = async function (pollId, metadata) {
  // NOTE: May be possible as a single operation using a jsonb datatype
  const poll = await exports.getPoll(pollId);
  metadata = { ...poll.metadata, ...metadata };

  return db('Poll')
    .where({ id: pollId })
    .update({ metadata })
    .returning('*');
};
