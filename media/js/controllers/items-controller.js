ASTool.ItemsController = Em.ArrayController.extend(ASTool.RouteBrowseMixin, {
	
	needs: ['application', 'annotation'],

	documentView: null,

	addItem: function() {
		var newItem = ASTool.Item.create({ name: 'new item ' + ASTool.guid().substring(0, 5) });
		this.pushObject(newItem);
	},
	
	addField: function(owner, name, type) {
		var newField = ASTool.ItemField.create({ name: name || 'new field',
										         type: type || 'text',
										         required: false,
										         vary: false });
		owner.set('fields', owner.fields || []);
		owner.fields.pushObject(newField);
	},

	saveChanges: function() {
		this.get('slyd').saveItems(this.content.toArray()).then(function() {
				this.back();
			}.bind(this));
	},

	actions: {
		
		addItem: function() {
			this.addItem();
		},
		
		addField: function(item) {
			this.addField(item);
		},
		
		deleteItem: function(item) {
			this.removeObject(item);
		},

		deleteField: function(item, field) {
			item.get('fields').removeObject(field);
		},

		saveChanges: function() {
			this.saveChanges();
		},

		undoChanges: function() {
			this.get('slyd').loadItems().then(function(items) {
				this.set('content', items);
				this.back();
			}.bind(this));
		},
	},

	willEnter: function() {
		this.set('documentView.canvas.interactionsBlocked', true);
	},

	willLeave: function() {
		this.set('documentView.canvas.interactionsBlocked', false);
	},
});