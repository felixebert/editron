const m = require("mithril");


module.exports = {
    view(vnode) {
        if (vnode.attrs.description == null) {
            return "";
        }
        return m(".editron-container__description.mmf-meta", m.trust(vnode.attrs.description));
    }
};