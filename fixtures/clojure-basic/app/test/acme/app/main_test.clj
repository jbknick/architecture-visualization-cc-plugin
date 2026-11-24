(ns acme.app.main-test
  (:require [clojure.test :refer [deftest is]]
            [acme.app.main :as main]))

(deftest run-gives-an-area
  (is (pos? (main/run ["a"]))))
