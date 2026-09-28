/*
 * Global Store switch. The header flag dropdown opens the confirm modal; Yes lands on
 * the same page in the other storefront, which is a separate CloudCraze storefront with
 * its own catalogue, price lists and currency, so the cart does not travel with you.
 */
(function (window, document) {
    function switchStore(store) {
        var url = window.location.pathname + window.location.search;
        url = url.replace(/([?&])store=[^&]*/, '$1').replace(/[?&]$/, '');
        window.location.href = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'store=' + store;
    }

    window.getRemoteContact = function () {
        switchStore('US');
    };

    window.getRemoteContactCA = function () {
        switchStore('CA');
    };
}(window, document));
