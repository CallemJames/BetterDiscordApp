import { Settings, Globals, WebpackModules, ReactComponents, MonkeyPatch, Cache } from 'modules';
import { VueInjector } from 'ui';

import AutocompleteComponent from './components/common/Autocomplete.vue';
import { Utils } from 'common';

export default new class AutoComplete {

    get sets() {
        return this._sets || (this._sets = {});
    }

    async init() {
        this.cta = await ReactComponents.getComponent('ChannelTextArea', { selector: WebpackModules.getSelector('channelTextArea', 'emojiButton') });
        MonkeyPatch('BD:EMOTEMODULE', this.cta.component.prototype).after('render', this.channelTextAreaAfterRender.bind(this));
        this.initialized = true;
    }

    get latestComponent() {
        return this._latestComponent;
    }

    channelTextAreaAfterRender(component, args, retVal) {
        const inner = Utils.findInReactTree(retVal, filter => filter && filter.className && filter.className.includes('inner'));

        if (!inner || !inner.children) return;
        inner.children.splice(0, 0, VueInjector.createReactElement(AutocompleteComponent, {
            controller: this,
            _insertText: component.insertText.bind(component)
        }));
    }

    add(prefix, controller) {
        if (!this.initialized) this.init();
        if (this.sets.hasOwnProperty(prefix)) return;
        this.sets[prefix] = controller;
    }

    remove(prefix) {
        if (this.sets.hasOwnProperty(prefix)) delete this.sets[prefix];
    }

    validPrefix(prefix) {
        return this.sets.hasOwnProperty(prefix);
    }

    items(prefix, sterm) {
        if (!this.validPrefix(prefix)) return [];
        return this.sets[prefix].acsearch(sterm);
    }

}
