const gp = require("gson-pointer");
const Core = require("json-schema-library").cores.JsonEditor;
const addValidator = require("json-schema-library/lib/addValidator");
const DataService = require("./services/DataService");
const SchemaService = require("./services/SchemaService");
const ValidationService = require("./services/ValidationService");
const LocationService = require("./services/LocationService");
const State = require("./services/State");
const selectEditor = require("./utils/selectEditor");
const _createElement = require("./utils/createElement");
const addItem = require("./utils/addItem");
const UISchema = require("./utils/UISchema");
const getID = require("./utils/getID");
const plugin = require("./plugin");
const i18n = require("./utils/i18n");
const createProxy = require("./utils/createProxy");


function isValidPointer(pointer) {
    return pointer[0] === "#";
}

function assertValidPointer(pointer) {
    if (isValidPointer(pointer) === false) {
        throw new Error(`Invalid json(schema)-pointer: ${pointer}`);
    }
}


// removes the editor from the instances-inventory of active editors
function removeEditorFrom(instances, editor) {
    const pointer = editor.getPointer();
    if (instances[pointer]) {
        instances[pointer] = instances[pointer].filter(instance => editor !== instance);
        if (instances[pointer].length === 0) {
            delete instances[pointer];
        }
    }
}

function eachInstance(instances, cb) {
    Object.keys(instances).forEach(pointer => {
        instances[pointer].forEach(editor => cb(pointer, editor));
    });
}


/**
 * Main component to build editors. Each editor should receive the controller, which carries all required services
 * for editor initialization
 *
 * ### Usage
 *
 * Instantiate the controller
 *
 * ```js
 * import { Controller } from "editron";
 * // jsonSchema = { type: "object", required: ["title"], properties: { title: { type: "string" } } }
 * const editron = new Controller(jsonSchema);
 * ```
 *
 * or, using all parameters
 *
 * ```js
 *  import { Controller } from "editron";
 *  // jsonSchema = { type: "object", required: ["title"], properties: { title: { type: "string" } } }
 *  // data = { title: "Hello" } - or simply use {}
 *  // options = { editors: [ complete list of custom editors ] }
 *  const editron = new Controller(jsonSchema, data, options);
 * ```
 *
 * and start rendering editors
 *
 * ```js
 *  const editor = editron.createEditor("#", document.querySelector("#editor"));
 *  // render from title only: editron.createEditor("#/title", document.querySelector("#title"));
 * ```
 *
 * to fetch the generated data use
 *
 * ```js
 *  const data = editron.getData();
 * ```
 *
 * @param  {Object} schema          - json schema describing required data/form template
 * @param  {Any} data               - initial data for given json-schema
 * @param  {Object} [options]       - configuration options
 * @param  {Array} options.editors  - list of editron-editors/widgets to use. Order defines editor to use
 *      (based on editorOf-method)
 */
class Controller {
    constructor(schema = {}, data = {}, options = {}) {
        schema = UISchema.extendSchema(schema);

        this.options = Object.assign({
            editors: [
                ...plugin.getEditors(),
                require("./editors/oneofeditor"),
                require("./editors/arrayeditor"),
                require("./editors/objecteditor"),
                require("./editors/valueeditor")
            ]
        }, options);

        this.disabled = false;
        this.editors = this.options.editors;
        this.state = new State();
        this.instances = {};
        this.core = new Core();
        this._proxy = createProxy(this.options.proxy);

        plugin.getValidators().forEach(([validationType, ...validator]) => {
            try {
                if (validationType === "format") {
                    return this.addFormatValidator(...validator);
                } else if (validationType === "keyword") {
                    return this.addKeywordValidator(...validator);
                }
                throw new Error(`Unknown validation type '${validationType}'`);
            } catch (e) {
                console.log("Error:", e.message);
            }
            return false;
        });

        this.schemaService = new SchemaService(schema, data, this.core);
        this.validationService = new ValidationService(this.state, schema, this.core);
        // enable i18n error-translations
        this.validationService.setErrorHandler(error => i18n.translateError(this, error));
        // merge given data with template data
        data = this.schemaService.addDefaultData(data, schema);
        this.dataService = new DataService(this.state, data);
        // start validation after data has been updated
        this.onAfterDataUpdate = this.dataService
            .on(DataService.EVENTS.AFTER_UPDATE, this.onAfterDataUpdate.bind(this));
        // run initial validation
        this.validateAll();
    }

    resetUndoRedo() {
        this.dataService.resetUndoRedo();
    }

    setActive(active = true) {
        const disabled = active === false;
        if (this.disabled === disabled) {
            return;
        }
        this.disabled = disabled;
        eachInstance(this.getInstances(), (pointer, editor) => {
            editor.setActive(!this.disabled);
        });
    }

    isActive() {
        return !this.disabled;
    }

    /**
     * Helper to create dom elements via mithril syntax
     *
     * @param  {String} selector    - a css selector describing the desired element
     * @param  {Object} attributes  - a map of dom attribute:value of the element (reminder className = class)
     * @return {HTMLDomElement} the resulting DOMHtml element (not attached)
     */
    createElement(selector, attributes) { // eslint-disable-line class-methods-use-this
        return _createElement(selector, attributes);
    }

    /**
     * The only entry point to create editors.
     * Use in application and from editors to create (delegate) child editors
     *
     * @param  {String} pointer         - data pointer to editor in current state
     * @param  {HTMLElement} element    - parent element of create editor. Will be appended automatically
     * @param  {Object} [options]       - individual editor options
     * @return {Object|undefined} created editor-instance or undefined;
     */
    createEditor(pointer, element, options) {
        if (pointer == null || element == null) {
            throw new Error(`Missing ${pointer == null ? "pointer" : "element"} in createEditor`);
        }

        assertValidPointer(pointer);

        // merge schema["editron:ui"] object with options. options precede
        const instanceOptions = Object.assign(
            {
                id: getID(pointer),
                pointer,
                disabled: this.disabled
            },
            UISchema.copyOptions(pointer, this),
            options
        );

        // find a matching editor
        const Editor = selectEditor(this.getEditors(), pointer, this, instanceOptions);
        if (Editor === false) {
            return undefined;
        }

        if (Editor === undefined) {
            console.warn(`Could not resolve an editor for ${pointer}`, this.schema().get(pointer));
            return undefined;
        }

        // iniitialize editor and save editor in list
        // @TODO loose reference to destroyed editors
        const editor = new Editor(pointer, this, instanceOptions);
        element.appendChild(editor.toElement());
        editor.setActive(!this.disabled);
        this.addInstance(pointer, editor);

        return editor;
    }

    /**
     * Call this method, when your editor is destroyed, deregistering its instance on editron
     * @param  {Instance} editor    - editor instance to remove
     */
    removeInstance(editor) {
        // controller inserted child and removes it here again
        const $element = editor.toElement();
        if ($element.parentNode) {
            $element.parentNode.removeChild($element);
        }

        removeEditorFrom(this.instances, editor);
    }

    addInstance(pointer, editor) {
        this.instances[pointer] = this.instances[pointer] || [];
        this.instances[pointer].push(editor);
    }

    /**
     * Request to insert a child item (within the data) at the given pointer. If multiple options are present, a
     * dialogue is opened to let the user select the appropriate type of child (oneof).
     * @param {String} pointer  - to array on which to insert the child
     * @param {Number} index    - index within array, where the child should be inserted (does not replace). Default: 0
     */
    addItemTo(pointer, index = 0) {
        addItem(this.data(), this.schema(), pointer, index);
        LocationService.goto(gp.join(pointer, index, true));
    }

    /**
     * Get or update data from a pointer
     * @return {DataService} DataService instance
     */
    data() { return this.dataService; }

    /**
     * Get the json schema from a pointer or replace the schema
     * @return {SchemaService} SchemaService instance
     */
    schema() { return this.schemaService; }

    /**
     * @return {Foxy} proxy instance
     */
    proxy() { return this._proxy; }

    /**
     * Validate data based on a json-schema and register to generated error events
     *
     * - start validation
     * - get your current errors at _pointer_
     * - hook into validation to receive your errors at _pointer_
     *
     * @return {ValidationService} ValidationService instance
     */
    validator() { return this.validationService; }

    /**
     * ## Usage
     *  goto(pointer) - Jump to given json pointer. This might also load another page if the root property changes.
     *  setCurrent(pointer) - Update current pointer, but do not jump to target
     *
     * @return {Object} LocationService-Singleton
     */
    location() { return LocationService; }

    /**
     * Set the application data
     * @param {Any} data    - json data matching registered json-schema
     */
    setData(data) {
        data = this.schemaService.addDefaultData(data);
        this.data().set("#", data);
    }

    /**
     * @param {JsonPointer} [pointer="#"] - location of data to fetch. Defaults to root (all) data
     * @return {Any} data at the given location
     */
    getData(pointer = "#") {
        return this.data().get(pointer);
    }

    /**
     * @return {Array} registered editor-widgets used to edit the json-data
     */
    getEditors() { return this.editors; }

    /**
     * @return {Object} currently active editor/widget instances
     */
    getInstances() { return this.instances; }

    /**
     * @param {String} format       - value of _format_
     * @param {Function} validator  - validator function receiving (core, schema, value, pointer). Return `undefined`
     *      for a valid _value_ and an object `{type: "error", message: "err-msg", data: { pointer }}` as error. May
     *      als return a promise
     */
    addFormatValidator(format, validator) {
        addValidator.format(this.core, format, validator);
    }

    /**
     * @param {String} datatype     - JSON-Schema datatype to register attribute, e.g. "string" or "object"
     * @param {String} keyword      - custom keyword
     * @param {Function} validator  - validator function receiving (core, schema, value, pointer). Return `undefined`
     *      for a valid _value_ and an object `{type: "error", message: "err-msg", data: { pointer }}` as error. May
     *      als return a promise
     */
    addKeywordValidator(datatype, keyword, validator) {
        addValidator.keyword(this.core, datatype, keyword, validator);
    }

    /**
     * Change the new schema for the current data
     * @param {Object} schema   - a valid json-schema
     */
    setSchema(schema) {
        schema = UISchema.extendSchema(schema);
        this.validationService.set(schema);
        this.schemaService.setSchema(schema);
    }

    // update data in schema service
    update() {
        this.schemaService.setData(this.dataService.get());
    }

    /**
     * Starts validation of current data
     */
    validateAll() {
        setTimeout(() =>
            this.destroyed !== true && this.validationService.validate(this.dataService.getDataByReference())
        );
    }

    /**
     * Destroy the editor, its widgets and services
     */
    destroy() {
        // delete all editors
        Object.keys(this.instances).forEach(pointer => {
            this.instances[pointer] && this.instances[pointer].forEach(instance => instance.destroy());
        });

        this.destroyed = true;
        this.instances = {};
        this.schemaService.destroy();
        this.validationService.destroy();
        this.dataService.destroy();
        this.dataService.off(DataService.EVENTS.AFTER_UPDATE, this.onAfterDataUpdate);
    }

    onAfterDataUpdate({ pointer }) {
        this.update();

        // @feature selective-validation
        if (pointer.includes("/")) {
            // @attention validate parent-object or array, in order to support parent-validators.
            // Any higher validators will still be ignore
            pointer = pointer.replace(/\/[^/]+$/, "");
        }

        setTimeout(() => {
            const data = this.dataService.getDataByReference();
            this.destroyed !== true && this.validationService.validate(data, pointer);
        });
    }

    changePointer(newPointer, editor) {
        removeEditorFrom(this.instances, editor);
        this.addInstance(newPointer, editor);
    }
}


module.exports = Controller;
