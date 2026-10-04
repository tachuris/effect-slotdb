import { SchemaIndex, seed } from '@tachuris/effect-slotdb/migration'
import { PeerRoster, PeerSyncState } from '@tachuris/effect-slotdb/replication'

export default SchemaIndex.seed({
  file: '0000',
  name: 'support',
  entities: {
    // Use the package declaration so metadata queries resolve renamed tables.
    peers: seed(PeerRoster),

    // A cursor in this peer's local change sequence.
    syncMeta: seed(PeerSyncState),
  },
})
