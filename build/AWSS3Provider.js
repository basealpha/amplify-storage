"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AWSS3Provider = void 0;
/* eslint-disable */
// @ts-nocheck
/**
 * Overriding the default provider to bypass issues with encryption
 */
/*
 * Copyright 2017-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with
 * the License. A copy of the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */
const core_1 = require("@aws-amplify/core");
const client_s3_1 = require("@aws-sdk/client-s3");
const util_format_url_1 = require("@aws-sdk/util-format-url");
const util_create_request_1 = require("@aws-sdk/util-create-request");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const axios_http_handler_1 = require("@aws-amplify/storage/lib/providers/axios-http-handler");
const AWSS3ProviderManagedUpload_1 = require("@aws-amplify/storage/lib/providers/AWSS3ProviderManagedUpload");
const events = require("events");
const logger = new core_1.ConsoleLogger('AWSS3Provider');
const AMPLIFY_SYMBOL = (typeof Symbol !== 'undefined' &&
    typeof Symbol.for === 'function'
    ? Symbol.for('amplify_default')
    : '@@amplify_default');
const dispatchStorageEvent = (track, event, attrs, metrics, message) => {
    if (track) {
        core_1.Hub.dispatch('storage', {
            event,
            data: { attrs, metrics },
            message,
        }, 'Storage', AMPLIFY_SYMBOL);
    }
};
const localTestingStorageEndpoint = 'http://localhost:20005';
/**
 * Provide storage methods to use AWS S3
 */
class AWSS3Provider {
    /**
     * Initialize Storage with AWS configurations
     * @param {Object} config - Configuration object for storage
     */
    constructor(config) {
        this._config = config ? config : {};
        logger.debug('Storage Options', this._config);
    }
    /**
     * get the category of the plugin
     */
    getCategory() {
        return AWSS3Provider.CATEGORY;
    }
    /**
     * get provider name of the plugin
     */
    getProviderName() {
        return AWSS3Provider.PROVIDER_NAME;
    }
    /**
     * Configure Storage part with aws configuration
     * @param {Object} config - Configuration of the Storage
     * @return {Object} - Current configuration
     */
    configure(config) {
        logger.debug('configure Storage', config);
        if (!config)
            return this._config;
        const amplifyConfig = core_1.Parser.parseMobilehubConfig(config);
        this._config = Object.assign({}, this._config, amplifyConfig.Storage);
        if (!this._config.bucket) {
            logger.debug('Do not have bucket yet');
        }
        return this._config;
    }
    /**
     * Get a presigned URL of the file or the object data when download:true
     *
     * @param {string} key - key of the object
     * @param {Object} [config] - { level : private|protected|public, download: true|false }
     * @return - A promise resolves to Amazon S3 presigned URL on success
     */
    async get(key, config) {
        const credentialsOK = await this._ensureCredentials();
        if (!credentialsOK) {
            return Promise.reject('No credentials');
        }
        const opt = Object.assign({}, this._config, config);
        const { bucket, download, cacheControl, contentDisposition, contentEncoding, contentLanguage, contentType, expires, track, } = opt;
        const prefix = this._prefix(opt);
        const final_key = prefix + key;
        const s3 = this._createNewS3Client(opt);
        logger.debug('get ' + key + ' from ' + final_key);
        const params = {
            Bucket: bucket,
            Key: final_key,
        };
        // See: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#getObject-property
        if (cacheControl)
            params.ResponseCacheControl = cacheControl;
        if (contentDisposition)
            params.ResponseContentDisposition = contentDisposition;
        if (contentEncoding)
            params.ResponseContentEncoding = contentEncoding;
        if (contentLanguage)
            params.ResponseContentLanguage = contentLanguage;
        if (contentType)
            params.ResponseContentType = contentType;
        if (opt.SSECustomerAlgorithm) {
            params.SSECustomerAlgorithm = opt.SSECustomerAlgorithm;
        }
        if (opt.SSECustomerKey) {
            params.SSECustomerKey = opt.SSECustomerKey;
        }
        if (opt.SSECustomerKeyMD5) {
            params.SSECustomerKeyMD5 = opt.SSECustomerKeyMD5;
        }
        if (download === true) {
            const getObjectCommand = new client_s3_1.GetObjectCommand(params);
            try {
                const response = await s3.send(getObjectCommand);
                dispatchStorageEvent(track, 'download', { method: 'get', result: 'success' }, {
                    fileSize: Number(response.Body['size'] || response.Body['length']),
                }, `Download success for ${key}`);
                return response;
            }
            catch (error) {
                dispatchStorageEvent(track, 'download', {
                    method: 'get',
                    result: 'failed',
                }, null, `Download failed with ${error.message}`);
                throw error;
            }
        }
        params.Expires = expires || 900; // Default is 15 mins as defined in V2 AWS SDK
        try {
            const signer = new s3_request_presigner_1.S3RequestPresigner(Object.assign({}, s3.config));
            const request = await util_create_request_1.createRequest(s3, new client_s3_1.GetObjectCommand(params));
            const url = util_format_url_1.formatUrl((await signer.presign(request, { expiresIn: params.Expires })));
            dispatchStorageEvent(track, 'getSignedUrl', { method: 'get', result: 'success' }, null, `Signed URL: ${url}`);
            return url;
        }
        catch (error) {
            logger.warn('get signed url error', error);
            dispatchStorageEvent(track, 'getSignedUrl', { method: 'get', result: 'failed' }, null, `Could not get a signed URL for ${key}`);
            throw error;
        }
    }
    /**
     * Put a file in S3 bucket specified to configure method
     * @param {string} key - key of the object
     * @param {Object} object - File to be put in Amazon S3 bucket
     * @param {Object} [config] - { level : private|protected|public, contentType: MIME Types,
     *  progressCallback: function }
     * @return - promise resolves to object on success
     */
    async put(key, object, config) {
        const credentialsOK = await this._ensureCredentials();
        if (!credentialsOK) {
            return Promise.reject('No credentials');
        }
        const opt = Object.assign({}, this._config, config);
        const { bucket, track, progressCallback } = opt;
        const { contentType, contentDisposition, cacheControl, expires, metadata, tagging, acl, } = opt;
        const { serverSideEncryption, SSECustomerAlgorithm, SSECustomerKey, SSECustomerKeyMD5, SSEKMSKeyId, } = opt;
        const type = contentType ? contentType : 'binary/octet-stream';
        const prefix = this._prefix(opt);
        const final_key = prefix + key;
        logger.debug('put ' + key + ' to ' + final_key);
        const params = {
            Bucket: bucket,
            Key: final_key,
            Body: object,
            ContentType: type,
        };
        if (cacheControl) {
            params.CacheControl = cacheControl;
        }
        if (contentDisposition) {
            params.ContentDisposition = contentDisposition;
        }
        if (expires) {
            params.Expires = expires;
        }
        if (metadata) {
            params.Metadata = metadata;
        }
        if (tagging) {
            params.Tagging = tagging;
        }
        if (serverSideEncryption) {
            // params.ServerSideEncryption = serverSideEncryption; // Including this breaks custom key implementation
            if (SSECustomerAlgorithm) {
                params.SSECustomerAlgorithm = SSECustomerAlgorithm;
            }
            if (SSECustomerKey) {
                params.SSECustomerKey = SSECustomerKey;
            }
            if (SSECustomerKeyMD5) {
                params.SSECustomerKeyMD5 = SSECustomerKeyMD5;
            }
            if (SSEKMSKeyId) {
                params.SSEKMSKeyId = SSEKMSKeyId;
            }
        }
        const emitter = new events.EventEmitter();
        const uploader = new AWSS3ProviderManagedUpload_1.AWSS3ProviderManagedUpload(params, opt, emitter);
        if (acl) {
            params.ACL = acl;
        }
        try {
            emitter.on('sendProgress', (progress) => {
                if (progressCallback) {
                    if (typeof progressCallback === 'function') {
                        progressCallback(progress);
                    }
                    else {
                        logger.warn('progressCallback should be a function, not a ' +
                            typeof progressCallback);
                    }
                }
            });
            const response = await uploader.upload();
            logger.debug('upload result', response);
            dispatchStorageEvent(track, 'upload', { method: 'put', result: 'success' }, null, `Upload success for ${key}`);
            return {
                key,
            };
        }
        catch (error) {
            logger.warn('error uploading', error);
            dispatchStorageEvent(track, 'upload', { method: 'put', result: 'failed' }, null, `Error uploading ${key}`);
            throw error;
        }
    }
    /**
     * Remove the object for specified key
     * @param {string} key - key of the object
     * @param {Object} [config] - { level : private|protected|public }
     * @return - Promise resolves upon successful removal of the object
     */
    async remove(key, config) {
        const credentialsOK = await this._ensureCredentials();
        if (!credentialsOK) {
            return Promise.reject('No credentials');
        }
        const opt = Object.assign({}, this._config, config);
        const { bucket, track } = opt;
        const prefix = this._prefix(opt);
        const final_key = prefix + key;
        const s3 = this._createNewS3Client(opt);
        logger.debug('remove ' + key + ' from ' + final_key);
        const params = {
            Bucket: bucket,
            Key: final_key,
        };
        const deleteObjectCommand = new client_s3_1.DeleteObjectCommand(params);
        try {
            const response = await s3.send(deleteObjectCommand);
            dispatchStorageEvent(track, 'delete', { method: 'remove', result: 'success' }, null, `Deleted ${key} successfully`);
            return response;
        }
        catch (error) {
            dispatchStorageEvent(track, 'delete', { method: 'remove', result: 'failed' }, null, `Deletion of ${key} failed with ${error}`);
            throw error;
        }
    }
    /**
     * List bucket objects relative to the level and prefix specified
     * @param {string} path - the path that contains objects
     * @param {Object} [config] - { level : private|protected|public }
     * @return - Promise resolves to list of keys for all objects in path
     */
    async list(path, config) {
        const credentialsOK = await this._ensureCredentials();
        if (!credentialsOK) {
            return Promise.reject('No credentials');
        }
        const opt = Object.assign({}, this._config, config);
        const { bucket, track, maxKeys } = opt;
        const prefix = this._prefix(opt);
        const final_path = prefix + path;
        const s3 = this._createNewS3Client(opt);
        logger.debug('list ' + path + ' from ' + final_path);
        const params = {
            Bucket: bucket,
            Prefix: final_path,
            MaxKeys: maxKeys,
        };
        const listObjectsCommand = new client_s3_1.ListObjectsCommand(params);
        try {
            const response = await s3.send(listObjectsCommand);
            let list = [];
            if (response && response.Contents) {
                list = response.Contents.map((item) => {
                    return {
                        key: item.Key.substr(prefix.length),
                        eTag: item.ETag,
                        lastModified: item.LastModified,
                        size: item.Size,
                    };
                });
            }
            dispatchStorageEvent(track, 'list', { method: 'list', result: 'success' }, null, `${list.length} items returned from list operation`);
            logger.debug('list', list);
            return list;
        }
        catch (error) {
            logger.warn('list error', error);
            dispatchStorageEvent(track, 'list', { method: 'list', result: 'failed' }, null, `Listing items failed: ${error.message}`);
            throw error;
        }
    }
    /**
     * @private
     */
    _ensureCredentials() {
        return core_1.Credentials.get()
            .then((credentials) => {
            if (!credentials)
                return false;
            const cred = core_1.Credentials.shear(credentials);
            logger.debug('set credentials for storage', cred);
            this._config.credentials = cred;
            return true;
        })
            .catch((error) => {
            logger.warn('ensure credentials error', error);
            return false;
        });
    }
    /**
     * @private
     */
    _prefix(config) {
        const { credentials, level } = config;
        const customPrefix = config.customPrefix || {};
        const identityId = config.identityId || credentials.identityId;
        const privatePath = (customPrefix.private !== undefined ? customPrefix.private : 'private/') +
            identityId +
            '/';
        const protectedPath = (customPrefix.protected !== undefined
            ? customPrefix.protected
            : 'protected/') +
            identityId +
            '/';
        const publicPath = customPrefix.public !== undefined ? customPrefix.public : 'public/';
        switch (level) {
            case 'private':
                return privatePath;
            case 'protected':
                return protectedPath;
            default:
                return publicPath;
        }
    }
    /**
     * @private creates an S3 client with new V3 aws sdk
     */
    _createNewS3Client(config, emitter) {
        const { region, credentials, dangerouslyConnectToHttpEndpointForTesting, } = config;
        let localTestingConfig = {};
        if (dangerouslyConnectToHttpEndpointForTesting) {
            localTestingConfig = {
                endpoint: localTestingStorageEndpoint,
                tls: false,
                bucketEndpoint: false,
                forcePathStyle: true,
            };
        }
        const s3client = new client_s3_1.S3Client(Object.assign(Object.assign({ region,
            credentials, customUserAgent: core_1.getAmplifyUserAgent() }, localTestingConfig), { requestHandler: new axios_http_handler_1.AxiosHttpHandler({}, emitter) }));
        return s3client;
    }
}
exports.AWSS3Provider = AWSS3Provider;
AWSS3Provider.CATEGORY = 'Storage';
AWSS3Provider.PROVIDER_NAME = 'AWSS3';
/**
 * @deprecated use named import
 */
exports.default = AWSS3Provider;
/* eslint-enable */
//# sourceMappingURL=AWSS3Provider.js.map