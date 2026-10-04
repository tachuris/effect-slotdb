import * as Schema from 'effect/Schema'
import {
  seed,
  createdAt,
  deletedAt,
  growOnly,
  key,
  latch,
  local,
  unique,
  withDefault,
} from '@tachuris/effect-slotdb/migration'
import prev from './0000-support'

export default prev.appendMigration({
  file: '0001',
  name: 'tasks',
  entities: {
    tasks: seed(
      Schema.Struct({
        // Generated row identity with a reusable unique slug.
        id: key(1)(Schema.String),
        slug: unique(1)(Schema.String),
        title: Schema.String,
        // A string enum with a column default for existing rows.
        kind: withDefault('personal')(Schema.Literals(['personal', 'work', 'errand'])),
        // Completion merges by disjunction, so true remains true.
        completed: withDefault(0)(latch(Schema.BooleanFromBit)),
        // Tags merge by union and store as a JSON array in a TEXT column.
        tags: growOnly(Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String)))),
        // Keep notes local so peer writes do not overwrite peer specific edits.
        notes: local(Schema.NullOr(Schema.String)),
        ...createdAt,
        ...deletedAt,
      }),
    ),
    labels: seed(
      Schema.Struct({
        id: key(1)(Schema.String),
        name: unique(1)(Schema.String),
        color: Schema.NullOr(Schema.String),
        ...createdAt,
        ...deletedAt,
      }),
    ),
  },
})
