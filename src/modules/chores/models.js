const { db, errorLogger } = require('./../../db');
const polls = require('./../polls/models');

exports.getChores = async function getChores() {
  return db('chore')
    .select('*')
    .catch(errorLogger);
}

exports.getChoreValue = async function getChoreValue(choreName, startTime, endTime) {
  return db('chore_value')
    .where('chore_name', choreName )
    .where('created_at', '>', startTime)
    .where('created_at', '<=', endTime)
    .sum('value')
    .first()
    .catch(errorLogger)
}

exports.setChoreValues = async function setChoreValues(choreData) {
  return db('chore_value')
    .insert(choreData)
    .catch(errorLogger)
}

exports.claimChore = async function claimChore(choreName, slackId, claimedAt, messageId) {
  const previousClaims = await exports.getChoreClaims(choreName)
  const previousClaimedAt = (previousClaims.length === 0) ? new Date(0) : previousClaims.slice(-1)[0].claimed_at;
  const choreValue = await exports.getChoreValue(choreName, previousClaimedAt, claimedAt);

  const pollIds = await polls.createPoll();

  return db('chore_claim')
    .insert({
      chore_name: choreName,
      claimed_by: slackId,
      claimed_at: claimedAt,
      message_id: messageId,
      value: choreValue.sum,
      poll_id: pollIds[0],
    })
    .returning('poll_id')
    .catch(errorLogger);
}

exports.getChoreClaims = async function getChoreClaims(choreName) {
  return db('chore_claim')
    .select('*')
    .where({ chore_name: choreName })
    .catch(errorLogger);
}

exports.getUserChoreClaims = async function getUserChoreClaims(choreName, slackId) {
  return db('chore_claim')
    .select('*')
    .where({ chore_name: choreName, claimed_by: slackId })
    .catch(errorLogger);
}

exports.setChorePreference = async function setChorePreference(slackId, alphaChore, betaChore, preference) {
  if (alphaChore >= betaChore) throw new Error('Chores out of order');
  return db('chore_pref')
    .insert({
      preferred_by: slackId,
      alpha_chore: alphaChore,
      beta_chore: betaChore,
      preference: preference,
    })
    .onConflict(['preferred_by', 'alpha_chore', 'beta_chore'])
    .merge()
    .catch(errorLogger);
}

exports.getChorePreferences = async function getChorePreferences() {
  return db('chore_pref')
    .select('alpha_chore', 'beta_chore', 'preference')
    .catch(errorLogger);
}