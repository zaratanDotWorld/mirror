exports.up = function(knex, Promise) {
    return knex.schema.createTable('ChoreBreak', function(t) {
        t.increments('id').unsigned().primary();
        t.timestamps(useTimestamps = true, defaultToNow = true, useCamelCase = true);
        t.string('residentId').references('Resident.slackId').notNull();
        t.date('startDate').notNull();
        t.date('endDate').notNull();
        t.check('?? < ??', ['startDate', 'endDate']);
    });
};

exports.down = function(knex, Promise) {
    return knex.schema.dropTable('ChoreBreak');
};
