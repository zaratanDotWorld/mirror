const randomstring = require('randomstring');
const { Admin } = require('../src/core/index');
const { db } = require('../src/core/db');

exports.generateSlackId = function () {
  return randomstring.generate({
    charset: 'alphanumeric',
    capitalization: 'uppercase',
    length: 11,
  });
};

exports.createActiveUsers = async function (houseId, num, now) {
  for (let i = 0; i < num; i++) {
    const residentId = exports.generateSlackId();
    await Admin.activateResident(houseId, residentId, now);
  }
};

exports.resetDb = async function () {
  await db('ThingProposal').del();
  await db('ThingBuy').del();
  await db('Thing').del();

  await db('ChoreProposal').del();
  await db('ChoreBreak').del();
  await db('ChoreClaim').del();
  await db('ChoreValue').del();
  await db('ChorePref').del();
  await db('Chore').del();

  await db('HeartKarma').del();
  await db('HeartChallenge').del();
  await db('Heart').del();

  await db('PollVote').del();
  await db('Poll').del();

  await db('Resident').del();
  await db('House').del();
};
