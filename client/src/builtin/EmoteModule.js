/**
 * BetterDiscord Emote Module
 * Copyright (c) 2015-present Jiiks/JsSucks - https://github.com/Jiiks / https://github.com/JsSucks
 * All rights reserved.
 * https://betterdiscord.net
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
*/

import BuiltinModule from './BuiltinModule';
import path from 'path';
import { request } from 'vendor';

import { Utils, FileUtils, ClientLogger as Logger } from 'common';
import { DiscordApi, Settings, Globals, WebpackModules, ReactComponents, MonkeyPatch, Cache, Patcher, Database } from 'modules';
import { VueInjector } from 'ui';

import Emote from './EmoteComponent.js';
import Autocomplete from '../ui/components/common/Autocomplete.vue';

import GlobalAc from '../ui/autocomplete';

const EMOTE_SOURCES = [
    'https://static-cdn.jtvnw.net/emoticons/v1/:id/1.0',
    'https://cdn.frankerfacez.com/emoticon/:id/1',
    'https://cdn.betterttv.net/emote/:id/1x'
]

export default new class EmoteModule extends BuiltinModule {

    /**
     * @returns {String} Path to local emote database
     */
    get dbpath() { return path.join(Globals.getPath('data'), 'emotes.json') }

    /**
     * @returns {Map} Cached raw emote database
     */
    get database() { return this._db || (this._db = new Map()) }

    /**
     * @returns {Array} Favourite emotes
     */
    get favourites() { return this._favourites || (this._favourites = []) }

    /**
     * @returns {Array} Most used emotes
     */
    get mostUsed() { return this._mostUsed || (this._mostUsed = []) }

    get settingPath() { return ['emotes', 'default', 'enable'] }

    async enabled() {
        // Add ; prefix for autocomplete
        GlobalAc.add(';', this);

        if (!this.database.size) {
            await this.loadLocalDb();
        }

        // Read favourites and most used from database
        const userData = await Database.findOne({ 'id': 'EmoteModule' });
        if (userData) {
            if (userData.hasOwnProperty('favourites')) this._favourites = userData.favourites;
            if (userData.hasOwnProperty('mostused')) this._mostUsed = userData.mostused;
        }

        this.patchMessageContent();
        this.patchSendAndEdit();
    }

    async disabled() {
        // Unpatch all patches
        for (const patch of Patcher.getPatchesByCaller('BD:EMOTEMODULE')) patch.unpatch();
        // Remove ; prefix from autocomplete
        GlobalAc.remove(';');
    }

    /**
     * Load emotes from local database
     */
    async loadLocalDb() {
        const emotes = await FileUtils.readJsonFromFile(this.dbpath);
        for (const [index, emote] of emotes.entries()) {
            const { type, id, src, value } = emote;
            if (index % 10000 === 0) await Utils.wait();

            this.database.set(id, { id: emote.value.id || value, type });
        }
    }

    /**
     * Patches MessageContent render method
     */
    async patchMessageContent() {
        const MessageContent = await ReactComponents.getComponent('MessageContent', { selector: WebpackModules.getSelector('container', 'containerCozy', 'containerCompact', 'edited') });
        MonkeyPatch('BD:EMOTEMODULE', MessageContent.component.prototype).after('render', this.afterRenderMessageContent.bind(this));
        MessageContent.forceUpdateAll();
    }

    /**
     * Handle message render
     */
    afterRenderMessageContent(component, args, retVal) {
        const markup = Utils.findInReactTree(retVal, filter =>
            filter &&
            filter.className &&
            filter.className.includes('markup') &&
            filter.children.length >= 2);

        if (!markup) return;
        markup.children[1] = this.processMarkup(markup.children[1]);
    }

    /**
     * Patches MessageActions send and edit
     */
    patchSendAndEdit() {
        MonkeyPatch('BD:EMOTEMODULE', WebpackModules.getModuleByName('MessageActions')).instead('sendMessage', this.handleSendMessage.bind(this));
        MonkeyPatch('BD:EMOTEMODULE', WebpackModules.getModuleByName('MessageActions')).instead('editMessage', this.handleEditMessage.bind(this));
    }

    /**
     * Handle send message
     */
    async handleSendMessage(component, args, orig) {
        if (!args.length) return orig(...args);
        const { content } = args[1];
        if (!content) return orig(...args);

        const emoteAsImage = Settings.getSetting('emotes', 'default', 'emoteasimage').value &&
            (DiscordApi.currentChannel.type === 'DM' || DiscordApi.currentChannel.checkPermissions(DiscordApi.modules.DiscordPermissions.ATTACH_FILES));

        if (!emoteAsImage || content.split(' ').length > 1) {
            args[1].content = args[1].content.split(' ').map(word => {
                const isEmote = /;(.*?);/g.exec(word);
                if (isEmote) {
                    const emote = this.findByName(isEmote[1], true);
                    if (!emote) return word;
                    this.addToMostUsed(emote);
                    return emote ? `:${isEmote[1]}:` : word;
                }
                return word;
            }).join(' ');
            return orig(...args);
        }

        const isEmote = /;(.*?);/g.exec(content);
        if (!isEmote) return orig(...args);

        const emote = this.findByName(isEmote[1]);
        if (!emote) return orig(...args);
        this.addToMostUsed(emote);

        const FileActions = WebpackModules.getModuleByProps(['makeFile']);
        const Uploader = WebpackModules.getModuleByProps(['instantBatchUpload']);

        request.get(emote.props.src, { encoding: 'binary' }).then(res => {
            const arr = new Uint8Array(new ArrayBuffer(res.length));
            for (let i = 0; i < res.length; i++) arr[i] = res.charCodeAt(i);
            const suffix = arr[0] === 71 && arr[1] === 73 && arr[2] === 70 ? '.gif' : '.png';
            Uploader.upload(args[0], FileActions.makeFile(arr, `${emote.name}${suffix}`));
        });
    }

    /**
     * Handle edit message
     */
    handleEditMessage(component, args, orig) {
        if (!args.length) return orig(...args);
        const { content } = args[2];
        if (!content) return orig(...args);
        args[2].content = args[2].content.split(' ').map(word => {
            const isEmote = /;(.*?);/g.exec(word);
            return isEmote ? `:${isEmote[1]}:` : word;
        }).join(' ');
        return orig(...args);
    }

    /**
     * Add/update emote to most used
     * @param {Object} emote emote to add/update
     */
    addToMostUsed(emote) {
        const isMostUsed = this.mostUsed.find(mu => mu.key === emote.name);
        if (isMostUsed) {
            isMostUsed.useCount += 1;
        } else {
            this.mostUsed.push({
                key: emote.name,
                id: emote.id,
                type: emote.type,
                useCount: 1
            });
        }
        // Save most used to database
        // TODO only save first n
        Database.insertOrUpdate({ 'id': 'EmoteModule' }, { 'id': 'EmoteModule', favourites: this.favourites, mostused: this.mostUsed })
    }

    /**
     * Inject emotes into markup
     */
    processMarkup(markup) {
        const newMarkup = [];
        if (!(markup instanceof Array)) return markup;
        const jumboable = !markup.some(child => {
            if (typeof child !== 'string') return false;
            return / \w+/g.test(child);
        });

        for (const child of markup) {
            if (typeof child !== 'string') {
                if (typeof child === 'object') {
                    const isEmoji = Utils.findInReactTree(child, 'emojiName');
                    if (isEmoji) child.props.children.props.jumboable = jumboable;
                }
                newMarkup.push(child);
                continue;
            }

            if (!/:(\w+):/g.test(child)) {
                newMarkup.push(child);
                continue;
            }

            const words = child.split(/([^\s]+)([\s]|$)/g).filter(f => f !== '');

            let s = '';
            for (const word of words) {
                const isemote = /:(.*?):/g.exec(word);
                if (!isemote) {
                    s += word;
                    continue;
                }

                const emote = this.findByName(isemote[1]);
                if (!emote) {
                    s += word;
                    continue;
                }

                newMarkup.push(s);
                s = '';

                emote.jumboable = jumboable;
                newMarkup.push(emote.render());
            }
            if (s !== '') newMarkup.push(s);
        }
        if (newMarkup.length === 1) return newMarkup[0];
        return newMarkup;
    }

    /**
     * Find an emote by name
     * @param {String} name Emote name
     * @param {Boolean} simple Simple object or Emote instance
     * @returns {Object|Emote}
     */
    findByName(name, simple = false) {
        const emote = this.database.get(name);
        if (!emote) return null;
        return this.parseEmote(name, emote, simple);
    }

    /**
     * Parse emote object
     * @param {String} name Emote name
     * @param {Object} emote Emote object
     * @param {Boolean} simple Simple object or Emote instance
     * @returns {Object|Emote}
     */
    parseEmote(name, emote, simple = false) {
        const { type, id } = emote;
        if (type < 0 || type > 2) return null;
        return simple ? { type, id, name } : new Emote(type, id, name);
    }

    /**
     * Search for autocomplete
     * @param {any} regex
     */
    acsearch(regex) {
        if (regex.length <= 0) {
            return {
                type: 'imagetext',
                title: ['Your most used emotes'],
                items: this.mostUsed.sort((a,b) => b.useCount - a.useCount).slice(0, 10).map(mu => {
                    return {
                        key: `${mu.key} | ${mu.useCount}`,
                        value: {
                            src: EMOTE_SOURCES[mu.type].replace(':id', mu.id),
                            replaceWith: `;${mu.key};`
                        }
                    }
                })
            }
        }

        const results = this.search(regex);
        return {
            type: 'imagetext',
            title: ['Matching', regex.length],
            items: results.map(result => {
                result.value.src = EMOTE_SOURCES[result.value.type].replace(':id', result.value.id);
                result.value.replaceWith = `;${result.key};`;
                return result;
            })
        }
    }

    /**
     * Search for anything else
     * @param {any} regex
     * @param {any} limit
     */
    search(regex, limit = 10) {
        if (typeof regex === 'string') regex = new RegExp(regex, 'i');
        const matching = [];

        for (const [key, value] of this.database.entries()) {
            if (matching.length >= limit) break;
            if (regex.test(key)) matching.push({ key, value })
        }

        return matching;
    }

}
