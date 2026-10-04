import * as Schema from 'effect/Schema'
import { addOptional, migrateSchema } from '@tachuris/effect-slotdb/migration'
import prev from './0001-tasks'

export default prev.appendMigration({
  file: '0002',
  name: 'task-due-dates',
  entities: {
    tasks: migrateSchema(prev.schemas.tasks, addOptional('dueAt', Schema.DateTimeUtcFromString)),
  },
})
