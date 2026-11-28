(ns acme.ui.view
  (:require [acme.core.util :as u]))

(defn label [n]
  (str "size " (u/round-to n)))

(defn ^:export init []
  (js/console.log (label 3)))
