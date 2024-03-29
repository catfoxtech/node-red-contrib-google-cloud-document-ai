module.exports = function (RED) {
    'use strict';

    function ProcessorConfig(config) {
        RED.nodes.createNode(this, config);

        this.location = config.location;
        this.projectId = config.projectId;
        this.processorId = config.processorId;
        this.version = config.version;

        const gcpCredentials = RED.nodes.getNode(config.gcpCredentials);
        const credentials = JSON.parse(gcpCredentials.credentials.privateKey);

        const {DocumentProcessorServiceClient} = require('@google-cloud/documentai')[this.version];
        this.client = new DocumentProcessorServiceClient({
            credentials: credentials
        });

        const {Storage} = require('@google-cloud/storage');
        this.storage = new Storage({
            credentials: credentials
        });
    }

    function ProcessorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        this.processor = RED.nodes.getNode(config.processor);
        this.contentType = config.contentType;
        this.timeout = config.timeout;
        this.outputType = config.outputType;
        this.outputProperty = config.outputProperty;
        this.includeImages = config.includeImages;

        const ULID = require('ulid');

        const extractText = function (text, textAnchor) {
            let content = [];
            if (textAnchor && textAnchor.textSegments) {
                textAnchor.textSegments.forEach(function (textSegment) {
                    content.push(text.substring(textSegment.startIndex, textSegment.endIndex));
                });
            }

            return content.join("\n");
        };

        this.on('input', async function (msg, _send, done) {
            let document;

            const projectId = node.processor.projectId;
            const processorLocation = node.processor.location;
            const processorId = node.processor.processorId;

            const contentType = msg.contentType || node.contentType;
            const timeout = msg.timeout || node.timeout;

            let processorPath;
            if (node.processor.client.processorPath) {
                processorPath = node.processor.client.processorPath(projectId, processorLocation, processorId);
            } else {
                processorPath = `projects/${projectId}/locations/${processorLocation}/processors/${processorId}`;
            }

            const request = {
                name: processorPath
            };

            const options = {};
            if (timeout) {
                options.timeout = timeout;
            }

            if (msg.payload.bucket && msg.payload.name) {
                const bucket = msg.payload.bucket;
                const objectName = msg.payload.name;
                const ulid = ULID.ulid();

                request.inputDocuments = {
                    gcsDocuments: {
                        documents: [
                            {
                                gcsUri: `gs://${bucket}/${objectName}`,
                                mimeType: contentType
                            }
                        ]
                    }
                };
                request.documentOutputConfig = {
                    gcsOutputConfig: {
                        gcsUri: `gs://${bucket}/${objectName}/${ulid}/${processorId}/`,
                    }
                };

                try {
                    const [operation] = await node.processor.client.batchProcessDocuments(request, options);
                    await operation.promise();

                    const [files] = await node.processor.storage.bucket(bucket).getFiles({
                        prefix: `${objectName}/${ulid}/${processorId}/`,
                    });

                    const [file] = await files[0].download();

                    document = JSON.parse(file.toString());
                } catch (e) {
                    if (done) {
                        done(e);
                    } else {
                        node.error(e, msg);
                    }
                }
            } else {
                request.rawDocument = {
                    content: Buffer.isBuffer(msg.payload) ? msg.payload.toString('base64') : msg.payload,
                    mimeType: contentType
                }

                try {
                    const [result] = await node.processor.client.processDocument(request, options);

                    ({document} = result);
                } catch (e) {
                    if (done) {
                        done(e);
                    } else {
                        node.error(e, msg);
                    }
                }
            }

            if (!document) {
                return;
            }

            msg.doc = document;

            if (!node.includeImages) {
                if (Array.isArray(document.pages)) {
                    document.pages.forEach(function (page) {
                        delete page.image;
                    });
                }
            }

            if (this.outputType === 'document') {
                msg.payload = document[this.outputProperty] || document;
            } else if (this.outputType === 'fields') {
                const payload = {};

                if (Array.isArray(document.entities) && document.entities.length) {
                    document.entities.forEach(function (entity) {
                        payload[entity.type] = entity.mentionText;
                        // payload[entity.id] = entity.mentionText; // TODO add option to include indexed property?
                    });
                } else if (Array.isArray(document.pages)) {
                    const text = document.text;
                    document.pages.forEach(function (page) {
                        if (Array.isArray(page.formFields)) {
                            page.formFields.forEach(function (formField) {
                                const fieldName = extractText(text, formField.fieldName.textAnchor);
                                const fieldValue = extractText(text, formField.fieldValue.textAnchor);

                                payload[fieldName] = fieldValue;
                            });
                        }
                    });
                }

                msg.payload = payload;
            } else if (this.outputType === 'tables') {
                msg.payload = {};

                if (Array.isArray(document.pages)) {
                    const text = document.text;
                    msg.payload = document.pages.map(function (page) {
                        return page.tables.map(function (table) {
                            return table.headerRows.map(function (row) {
                                return row.cells.map(function (cell) {
                                    return extractText(text, cell.layout.textAnchor);
                                });
                            }).concat(table.bodyRows.map(function (row) {
                                return row.cells.map(function (cell) {
                                    return extractText(text, cell.layout.textAnchor);
                                });
                            }));
                        });
                    });
                }
            } else if (this.outputType === 'parts') {
                const payload = [];

                if (Array.isArray(document.entities)) {
                    document.entities.forEach(function (entity) {
                        const part = {};

                        if (entity.type) {
                            part.type = entity.type;
                        }
                        part.pages = entity.pageAnchor.pageRefs.map(function (pageRef) {
                            return pageRef.page || '0';
                        });

                        payload.push(part);
                    });
                }

                msg.payload = payload;
            } else {
                msg.payload = document;
            }

            _send(msg);
            if (done) {
                done();
            }
        });
    }

    RED.nodes.registerType('gcp-document-ai-processor-config', ProcessorConfig);
    RED.nodes.registerType('gcp-document-ai-processor', ProcessorNode);
}
