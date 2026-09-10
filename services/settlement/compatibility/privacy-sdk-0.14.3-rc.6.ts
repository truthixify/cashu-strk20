import type {
  Channel,
  IndexerDiscoveryProvider,
  PrivateTransfersInterface,
  ViewingKeyProvider,
} from "./dist/index.js";
import type {
  StarknetPrivacySdkChannelSnapshot,
  StarknetPrivacySdkIndexer,
  StarknetPrivacySdkPayoutTransfers,
  StarknetPrivacySdkViewingKeyProvider,
} from "./starknet-privacy-sdk-ports.js";

type Rc6NotesCursor = NonNullable<
  NonNullable<Parameters<IndexerDiscoveryProvider["discoverNotes"]>[2]>["cursor"]
>;
type Rc6ChannelCursor = Parameters<IndexerDiscoveryProvider["fetchHistory"]>[2];
type Rc6HistoryCursor = NonNullable<
  NonNullable<Parameters<IndexerDiscoveryProvider["fetchHistory"]>[3]>["historyCursor"]
>;

declare const channel: Channel;
declare const discoveryProvider: IndexerDiscoveryProvider;
declare const privateTransfers: PrivateTransfersInterface;
declare const viewingKeyProvider: ViewingKeyProvider;

const channelPort: StarknetPrivacySdkChannelSnapshot = channel;
const discoveryPort: StarknetPrivacySdkIndexer<Rc6NotesCursor, Rc6ChannelCursor, Rc6HistoryCursor> =
  discoveryProvider;
const payoutPort: StarknetPrivacySdkPayoutTransfers = privateTransfers;
const viewingKeyPort: StarknetPrivacySdkViewingKeyProvider = viewingKeyProvider;

void channelPort;
void discoveryPort;
void payoutPort;
void viewingKeyPort;
