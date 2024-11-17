"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PubSubAdapter = exports.createAdapter = void 0;
const socket_io_adapter_1 = require("socket.io-adapter");
const node_crypto_1 = require("node:crypto");
const msgpack_1 = require("@msgpack/msgpack");
const client_sns_1 = require("@aws-sdk/client-sns");
const debug = require("debug")("socket.io-aws-sqs-adapter");
function randomId() {
    return (0, node_crypto_1.randomBytes)(8).toString("hex");
}
async function createQueue(snsClient, sqsClient, opts) {
    var _a;
    const topicName = opts.topicName || "socket-io";
    debug("creating topic [%s]", topicName);
    const createTopicCommandOutput = await snsClient.createTopic({
        Name: topicName,
        Tags: opts.topicTags,
    });
    debug("topic [%s] was successfully created", topicName);
    const queueName = `${opts.queuePrefix || "socket-io"}-${randomId()}`;
    debug("creating queue [%s]", queueName);
    const createQueueCommandOutput = await sqsClient.createQueue({
        QueueName: queueName,
        tags: opts.queueTags,
    });
    debug("queue [%s] was successfully created", queueName);
    const queueUrl = createQueueCommandOutput.QueueUrl;
    const getQueueAttributesCommandOutput = await sqsClient.getQueueAttributes({
        QueueUrl: queueUrl,
        AttributeNames: ["QueueArn"],
    });
    const topicArn = createTopicCommandOutput.TopicArn;
    const queueArn = (_a = getQueueAttributesCommandOutput.Attributes) === null || _a === void 0 ? void 0 : _a.QueueArn;
    await sqsClient.setQueueAttributes({
        QueueUrl: queueUrl,
        Attributes: {
            Policy: JSON.stringify({
                Version: "2012-10-17",
                Id: "__default_policy_ID",
                Statement: [
                    {
                        Sid: "__owner_statement",
                        Effect: "Allow",
                        Principal: "*",
                        Action: "SQS:SendMessage",
                        Resource: queueArn,
                        Condition: {
                            ArnEquals: {
                                "aws:SourceArn": topicArn,
                            },
                        },
                    },
                ],
            }),
        },
    });
    const subscribeCommandOutput = await snsClient.subscribe({
        TopicArn: createTopicCommandOutput.TopicArn,
        Protocol: "sqs",
        Endpoint: queueArn,
        Attributes: { RawMessageDelivery: "true" },
    });
    debug("queue [%s] has successfully subscribed to topic [%s]", queueName, topicName);
    return {
        topicArn,
        queueName,
        queueUrl,
        subscriptionArn: subscribeCommandOutput.SubscriptionArn,
    };
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
function createAdapter(snsClient, sqsClient, opts = {}) {
    let isClosed = false;
    let _topicArn;
    const namespaceToAdapters = new Map();
    const queueCreation = createQueue(snsClient, sqsClient, opts);
    queueCreation
        .then(async ({ topicArn, queueName, queueUrl, subscriptionArn }) => {
        _topicArn = topicArn;
        namespaceToAdapters.forEach((adapter) => {
            adapter._topicArn = topicArn;
        });
        async function poll() {
            const output = await sqsClient.receiveMessage({
                QueueUrl: queueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 5,
                MessageAttributeNames: ["All"],
            });
            if (output.Messages) {
                debug("received %d message(s)", output.Messages.length);
                output.Messages.forEach((message) => {
                    var _a;
                    if (message.MessageAttributes === undefined ||
                        message.Body === undefined) {
                        debug("ignore malformed message");
                        return;
                    }
                    const namespace = message.MessageAttributes["nsp"].StringValue;
                    (_a = namespaceToAdapters.get(namespace)) === null || _a === void 0 ? void 0 : _a.onRawMessage(message);
                });
                await sqsClient.deleteMessageBatch({
                    QueueUrl: queueUrl,
                    Entries: output.Messages.map((message) => ({
                        Id: message.MessageId,
                        ReceiptHandle: message.ReceiptHandle,
                    })),
                });
            }
        }
        while (!isClosed) {
            try {
                debug("polling for new messages");
                await poll();
            }
            catch (err) {
                debug("an error has occurred: %s", err.message);
            }
        }
        try {
            await Promise.all([
                sqsClient.deleteQueue({
                    QueueUrl: queueUrl,
                }),
                snsClient.unsubscribe({
                    SubscriptionArn: subscriptionArn,
                }),
            ]);
            debug("queue [%s] was successfully deleted", queueName);
        }
        catch (err) {
            debug("an error has occurred while deleting the queue: %s", err.message);
        }
    })
        .catch((err) => {
        debug("an error has occurred while creating the queue: %s", err.message);
    });
    return function (nsp) {
        const adapter = new PubSubAdapter(nsp, snsClient, opts);
        adapter._topicArn = _topicArn;
        namespaceToAdapters.set(nsp.name, adapter);
        const defaultInit = adapter.init;
        adapter.init = () => {
            return queueCreation.then(() => {
                defaultInit.call(adapter);
            });
        };
        const defaultClose = adapter.close;
        adapter.close = () => {
            namespaceToAdapters.delete(nsp.name);
            if (namespaceToAdapters.size === 0) {
                isClosed = true;
            }
            defaultClose.call(adapter);
        };
        return adapter;
    };
}
exports.createAdapter = createAdapter;
class PubSubAdapter extends socket_io_adapter_1.ClusterAdapterWithHeartbeat {
    /**
     * Adapter constructor.
     *
     * @param nsp - the namespace
     * @param snsClient - an AWS SNS client
     * @param opts - additional options
     *
     * @public
     */
    constructor(nsp, snsClient, opts) {
        super(nsp, opts);
        this._topicArn = "";
        this.snsClient = snsClient;
    }
    doPublish(message) {
        const messageAttributes = {
            nsp: {
                DataType: "String",
                StringValue: this.nsp.name,
            },
            uid: {
                DataType: "String",
                StringValue: this.uid,
            },
        };
        // @ts-ignore
        if (message.data) {
            // no binary can be included in the body, so we include it in a message attribute
            messageAttributes.data = {
                DataType: "Binary",
                // @ts-ignore
                BinaryValue: (0, msgpack_1.encode)(message.data),
            };
        }
        return this.snsClient
            .send(new client_sns_1.PublishCommand({
            TopicArn: this._topicArn,
            Message: String(message.type),
            MessageAttributes: messageAttributes,
        }))
            .then();
    }
    doPublishResponse(requesterUid, response) {
        const messageAttributes = {
            nsp: {
                DataType: "String",
                StringValue: this.nsp.name,
            },
            uid: {
                DataType: "String",
                StringValue: this.uid,
            },
            requesterUid: {
                DataType: "String",
                StringValue: requesterUid,
            },
        };
        // @ts-ignore
        if (response.data) {
            messageAttributes.data = {
                DataType: "Binary",
                // @ts-ignore
                BinaryValue: (0, msgpack_1.encode)(response.data),
            };
        }
        return this.snsClient
            .send(new client_sns_1.PublishCommand({
            TopicArn: this._topicArn,
            Message: String(response.type),
            MessageAttributes: messageAttributes,
        }))
            .then();
    }
    onRawMessage(rawMessage) {
        var _a, _b, _c, _d;
        if (rawMessage.MessageAttributes === undefined ||
            rawMessage.Body === undefined) {
            debug("ignore malformed message");
            return;
        }
        if (((_a = rawMessage.MessageAttributes["uid"]) === null || _a === void 0 ? void 0 : _a.StringValue) === this.uid) {
            debug("ignore message from self");
            return;
        }
        const requesterUid = (_b = rawMessage.MessageAttributes["requesterUid"]) === null || _b === void 0 ? void 0 : _b.StringValue;
        if (requesterUid && requesterUid !== this.uid) {
            debug("ignore response for another node");
            return;
        }
        const decoded = {
            type: parseInt(rawMessage.Body, 10),
            nsp: (_c = rawMessage.MessageAttributes["nsp"]) === null || _c === void 0 ? void 0 : _c.StringValue,
            uid: (_d = rawMessage.MessageAttributes["uid"]) === null || _d === void 0 ? void 0 : _d.StringValue,
        };
        if (rawMessage.MessageAttributes["data"]) {
            decoded.data = (0, msgpack_1.decode)(rawMessage.MessageAttributes["data"].BinaryValue);
        }
        debug("received %j", decoded);
        if (requesterUid) {
            this.onResponse(decoded);
        }
        else {
            this.onMessage(decoded);
        }
    }
}
exports.PubSubAdapter = PubSubAdapter;
