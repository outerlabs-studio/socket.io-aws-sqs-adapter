import { ClusterAdapterWithHeartbeat } from "socket.io-adapter";
import type { ClusterAdapterOptions, ClusterMessage, ClusterResponse, Offset, ServerId } from "socket.io-adapter";
import type { CreateTopicCommandInput, SNS } from "@aws-sdk/client-sns";
import type { CreateQueueCommandInput, Message, SQS } from "@aws-sdk/client-sqs";
export interface AdapterOptions {
    /**
     * The name of the SNS topic.
     * @default "socket.io"
     */
    topicName?: string;
    /**
     * The tags to apply to the new SNS topic.
     */
    topicTags?: CreateTopicCommandInput["Tags"];
    /**
     * The prefix of the SQS queue.
     * @default "socket.io"
     */
    queuePrefix?: string;
    /**
     * The tags to apply to the new SQS queue.
     */
    queueTags?: CreateQueueCommandInput["tags"];
}
/**
 * Returns a function that will create a {@link PubSubAdapter} instance.
 *
 * @param snsClient - a client from the `@aws-sdk/client-sns` package
 * @param sqsClient - a client from the `@aws-sdk/client-sqs` package
 * @param opts - additional options
 *
 * @public
 */
export declare function createAdapter(snsClient: SNS, sqsClient: SQS, opts?: AdapterOptions & ClusterAdapterOptions): (nsp: any) => PubSubAdapter;
export declare class PubSubAdapter extends ClusterAdapterWithHeartbeat {
    private readonly snsClient;
    _topicArn: string;
    /**
     * Adapter constructor.
     *
     * @param nsp - the namespace
     * @param snsClient - an AWS SNS client
     * @param opts - additional options
     *
     * @public
     */
    constructor(nsp: any, snsClient: SNS, opts: AdapterOptions & ClusterAdapterOptions);
    protected doPublish(message: ClusterMessage): Promise<Offset>;
    protected doPublishResponse(requesterUid: ServerId, response: ClusterResponse): Promise<void>;
    onRawMessage(rawMessage: Message): void;
}
